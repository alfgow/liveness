import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import {
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const envFirst = (...keys) => keys.map((key) => process.env[key]).find((value) => value);

const app = express();
const PORT = process.env.LIVENESS_PORT || 3001;
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 92);
const SELFIE_BUCKET = process.env.SELFIE_BUCKET;
const SELFIE_KEY_TEMPLATE = process.env.SELFIE_KEY_TEMPLATE || 'tenants/{tenant_id}/prospects/{prospect_id}/selfie.jpg';
const REKOGNITION_REGION = envFirst('REKOGNITION_REGION', 'AWS_REGION') || 'us-east-1';
const S3_SELFIE_REGION = envFirst('S3_SELFIE_REGION', 'REKOGNITION_REGION', 'AWS_REGION') || 'us-east-1';
const EVIDENCE_BUCKET = process.env.LIVENESS_EVIDENCE_BUCKET;
const EVIDENCE_PREFIX = process.env.LIVENESS_EVIDENCE_PREFIX || 'liveness-evidence';
const LIVENESS_MIN_CONFIDENCE = Number(process.env.LIVENESS_MIN_CONFIDENCE || 90);
const ALGORITHM_VERSION = process.env.LIVENESS_ALGORITHM_VERSION || 'rekognition-face-liveness-v1';
const EVIDENCE_RETENTION_DAYS = Number(process.env.LIVENESS_EVIDENCE_RETENTION_DAYS || 0);
const APPLY_EVIDENCE_LIFECYCLE = process.env.LIVENESS_APPLY_LIFECYCLE_POLICY === 'true';
const AWS_ACCESS_KEY_ID = envFirst('LIVENESS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID');
const AWS_SECRET_ACCESS_KEY = envFirst('LIVENESS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY');
const AWS_SESSION_TOKEN = envFirst('LIVENESS_SESSION_TOKEN', 'AWS_SESSION_TOKEN');

const sharedCredentials = AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
  ? {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    ...(AWS_SESSION_TOKEN ? { sessionToken: AWS_SESSION_TOKEN } : {}),
  }
  : undefined;

app.use(cors());
app.use(express.json());

const rekognition = new RekognitionClient({
  region: REKOGNITION_REGION,
  ...(sharedCredentials ? { credentials: sharedCredentials } : {}),
});

const s3 = new S3Client({
  region: S3_SELFIE_REGION,
  ...(sharedCredentials ? { credentials: sharedCredentials } : {}),
});

const validationResultsBySession = new Map();

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const buildCanonicalSelfieKey = ({ tenant_id, prospect_id }) => {
  if (!prospect_id) {
    throw new Error('Falta prospect_id para construir la ruta canónica de selfie.');
  }

  return SELFIE_KEY_TEMPLATE
    .replace('{tenant_id}', tenant_id || 'default')
    .replace('{prospect_id}', prospect_id);
};

const normalizeEvidencePrefix = (prefix) => prefix.replace(/^\/+|\/+$/g, '');

const buildEvidenceObjectKey = ({ tenant_id, session_id }) => {
  const normalizedPrefix = normalizeEvidencePrefix(EVIDENCE_PREFIX);
  const tenant = tenant_id || 'default';

  return `${normalizedPrefix}/${tenant}/${session_id}/canonical.jpg`;
};

const getAuditImageQualityScore = (auditImage, index) => {
  const brightness = auditImage.Quality?.Brightness || 0;
  const sharpness = auditImage.Quality?.Sharpness || 0;

  return (brightness + sharpness) + index;
};

const selectCanonicalEvidence = (livenessResponse) => {
  if (livenessResponse.ReferenceImage?.S3Object || livenessResponse.ReferenceImage?.Bytes) {
    return {
      ...livenessResponse.ReferenceImage,
      source: 'ReferenceImage',
      strategy: 'reference-image-priority',
    };
  }

  if (!livenessResponse.AuditImages?.length) {
    return null;
  }

  const bestAuditImage = livenessResponse.AuditImages
    .map((auditImage, index) => ({
      ...auditImage,
      index,
      qualityScore: getAuditImageQualityScore(auditImage, index),
    }))
    .sort((a, b) => b.qualityScore - a.qualityScore)[0];

  return {
    ...bestAuditImage,
    source: 'AuditImage',
    strategy: 'highest-quality-audit-frame',
  };
};

const toRekognitionImage = (image) => {
  if (image.Bytes) {
    return { Bytes: image.Bytes };
  }

  if (image.S3Object) {
    return {
      S3Object: {
        Bucket: image.S3Object.Bucket,
        Name: image.S3Object.Name,
        Version: image.S3Object.Version,
      },
    };
  }

  return null;
};

const applyEvidenceLifecyclePolicy = async () => {
  if (!EVIDENCE_BUCKET || !APPLY_EVIDENCE_LIFECYCLE || EVIDENCE_RETENTION_DAYS <= 0) {
    return;
  }

  const lifecycleCommand = new PutBucketLifecycleConfigurationCommand({
    Bucket: EVIDENCE_BUCKET,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'LivenessEvidenceRetention',
          Status: 'Enabled',
          Filter: {
            Prefix: `${normalizeEvidencePrefix(EVIDENCE_PREFIX)}/`,
          },
          Expiration: {
            Days: EVIDENCE_RETENTION_DAYS,
          },
        },
      ],
    },
  });

  await s3.send(lifecycleCommand);
  console.log(`Lifecycle policy aplicada para ${EVIDENCE_BUCKET} (${EVIDENCE_RETENTION_DAYS} días).`);
};

const uploadCanonicalEvidence = async ({ session_id, tenant_id, canonicalEvidence }) => {
  if (!EVIDENCE_BUCKET) {
    throw new Error('Falta variable LIVENESS_EVIDENCE_BUCKET para persistir evidencias de liveness.');
  }

  let canonicalBytes = canonicalEvidence.Bytes;

  if (!canonicalBytes && canonicalEvidence.S3Object) {
    const sourceObject = await s3.send(new GetObjectCommand({
      Bucket: canonicalEvidence.S3Object.Bucket,
      Key: canonicalEvidence.S3Object.Name,
    }));

    canonicalBytes = await streamToBuffer(sourceObject.Body);
  }

  if (!canonicalBytes) {
    throw new Error('No fue posible obtener bytes de la imagen canónica de liveness.');
  }

  const evidenceKey = buildEvidenceObjectKey({ tenant_id, session_id });

  await s3.send(new PutObjectCommand({
    Bucket: EVIDENCE_BUCKET,
    Key: evidenceKey,
    Body: canonicalBytes,
    ContentType: 'image/jpeg',
    Metadata: {
      sessionid: session_id,
      tenantid: tenant_id || 'default',
      source: canonicalEvidence.source,
      strategy: canonicalEvidence.strategy,
    },
  }));

  return {
    bucket: EVIDENCE_BUCKET,
    key: evidenceKey,
    s3Uri: `s3://${EVIDENCE_BUCKET}/${evidenceKey}`,
  };
};

const compareSelfieVsLiveness = async ({ tenant_id, prospect_id, selfie_key, livenessEvidence }) => {
  if (!SELFIE_BUCKET) {
    throw new Error('Falta variable SELFIE_BUCKET para recuperar la selfie canónica del prospecto.');
  }

  const canonicalSelfieKey = selfie_key || buildCanonicalSelfieKey({ tenant_id, prospect_id });
  const selfieObject = await s3.send(new GetObjectCommand({
    Bucket: SELFIE_BUCKET,
    Key: canonicalSelfieKey,
  }));

  const selfieBytes = await streamToBuffer(selfieObject.Body);
  const targetImage = toRekognitionImage(livenessEvidence);

  if (!targetImage) {
    throw new Error('No se encontró evidencia de liveness válida para comparar rostros.');
  }

  const compareCommand = new CompareFacesCommand({
    SourceImage: { Bytes: selfieBytes },
    TargetImage: targetImage,
    SimilarityThreshold: FACE_MATCH_THRESHOLD,
  });

  const compareResponse = await rekognition.send(compareCommand);
  const bestMatch = compareResponse.FaceMatches?.[0];
  const similarity = bestMatch?.Similarity || 0;

  return {
    score: similarity,
    match: similarity >= FACE_MATCH_THRESHOLD,
    threshold: FACE_MATCH_THRESHOLD,
    source: livenessEvidence.source,
    selfie_bucket: SELFIE_BUCKET,
    selfie_key: canonicalSelfieKey,
  };
};

app.post('/api/liveness/session', async (_req, res) => {
  try {
    const command = new CreateFaceLivenessSessionCommand({});

    const response = await rekognition.send(command);
    console.log('Sesión creada:', response.SessionId);

    res.json({
      session_id: response.SessionId,
      region: REKOGNITION_REGION,
    });
  } catch (error) {
    console.error('Error creando sesión:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Error al crear la sesión de liveness', details: error.message });
  }
});

app.post('/api/liveness/result', async (req, res) => {
  const {
    session_id,
    prospect_id,
    tenant_id,
    selfie_key,
  } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'Falta session_id' });
  }

  try {
    const command = new GetFaceLivenessSessionResultsCommand({
      SessionId: session_id,
    });

    const response = await rekognition.send(command);
    console.log('Resultados obtenidos:', response.Status);

    if (response.Status !== 'SUCCEEDED') {
      return res.status(400).json({ status: 'failed', message: 'La validación no fue exitosa o expiró.' });
    }

    const isLive = response.Confidence >= LIVENESS_MIN_CONFIDENCE;
    const canonicalEvidence = selectCanonicalEvidence(response);

    if (!canonicalEvidence) {
      return res.status(422).json({
        status: 'failed',
        message: 'Liveness SUCCEEDED pero no hay imagen de evidencia para comparación facial.',
      });
    }

    const evidenceStorage = await uploadCanonicalEvidence({
      session_id,
      tenant_id,
      canonicalEvidence,
    });

    const faceVerification = await compareSelfieVsLiveness({
      tenant_id,
      prospect_id,
      selfie_key,
      livenessEvidence: canonicalEvidence,
    });

    const approved = isLive && faceVerification.match;

    const validationRecord = {
      SessionId: session_id,
      tenantId: tenant_id || null,
      livenessStatus: response.Status,
      livenessConfidence: response.Confidence,
      faceMatchScore: faceVerification.score,
      faceMatchThreshold: faceVerification.threshold,
      match: faceVerification.match,
      approved,
      algorithmVersion: ALGORITHM_VERSION,
      evidence: {
        key: evidenceStorage.key,
        bucket: evidenceStorage.bucket,
        s3Uri: evidenceStorage.s3Uri,
        source: canonicalEvidence.source,
        selectionStrategy: canonicalEvidence.strategy,
      },
      createdAt: new Date().toISOString(),
    };

    validationResultsBySession.set(session_id, validationRecord);

    return res.json({
      status: 'success',
      live: isLive,
      confidence: response.Confidence,
      approved,
      face_verification: {
        session_id,
        score: faceVerification.score,
        threshold: faceVerification.threshold,
        match: faceVerification.match,
        source: faceVerification.source,
        selfie_bucket: faceVerification.selfie_bucket,
        selfie_key: faceVerification.selfie_key,
      },
      evidence: validationRecord.evidence,
      metadata: {
        SessionId: validationRecord.SessionId,
        tenantId: validationRecord.tenantId,
        timestamp: validationRecord.createdAt,
        livenessConfidence: validationRecord.livenessConfidence,
        faceMatchScore: validationRecord.faceMatchScore,
        algorithmVersion: validationRecord.algorithmVersion,
      },
      full_response: response,
    });
  } catch (error) {
    console.error('Error obteniendo resultados:', error);
    return res.status(500).json({ error: 'Error al obtener los resultados', details: error.message });
  }
});

app.get('/api/liveness/validation/:sessionId', (req, res) => {
  const validationResult = validationResultsBySession.get(req.params.sessionId);

  if (!validationResult) {
    return res.status(404).json({ error: 'No se encontró validación para el SessionId indicado.' });
  }

  return res.json(validationResult);
});

applyEvidenceLifecyclePolicy().catch((error) => {
  console.error('No se pudo aplicar lifecycle policy de evidencias:', error.message);
});

app.listen(PORT, () => {
  console.log(`Servidor de Liveness corriendo en http://localhost:${PORT}`);
});

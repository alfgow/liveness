import {
    CompareFacesCommand,
    CreateFaceLivenessSessionCommand,
    GetFaceLivenessSessionResultsCommand,
    RekognitionClient
} from '@aws-sdk/client-rekognition';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

// Configurar CORS
// Esto es importante para que el frontend local (e.g. localhost:5174) pueda comunicarse
app.use(cors());
app.use(express.json());

// Configurar AWS Client
const rekognition = new RekognitionClient({
  region: REKOGNITION_REGION,
  ...(sharedCredentials ? { credentials: sharedCredentials } : {}),
});

const s3 = new S3Client({
  region: S3_SELFIE_REGION,
  ...(sharedCredentials ? { credentials: sharedCredentials } : {}),
});

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
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

const getBestLivenessEvidence = (livenessResponse) => {
  if (livenessResponse.ReferenceImage?.S3Object || livenessResponse.ReferenceImage?.Bytes) {
    return {
      ...livenessResponse.ReferenceImage,
      source: 'ReferenceImage',
    };
  }

  if (!livenessResponse.AuditImages?.length) {
    return null;
  }

  const sortedAuditImages = [...livenessResponse.AuditImages].sort((a, b) => {
    const sizeA = a.Bytes?.length || 0;
    const sizeB = b.Bytes?.length || 0;
    return sizeB - sizeA;
  });

  return {
    ...sortedAuditImages[0],
    source: 'AuditImage',
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

// Endpoint: Crear sesión de liveness
app.post('/api/liveness/session', async (req, res) => {
  try {
    const command = new CreateFaceLivenessSessionCommand({
        // Opciones adicionales si se requieren
        // KmsKeyId: '...', // opcional
        // Settings: { ... } // opcional
    });

    const response = await rekognition.send(command);
    console.log('Sesión creada:', response.SessionId);
    
    // Devolvemos el session_id que espera el frontend
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

// Endpoint: Guardar/Obtener resultados
app.post('/api/liveness/result', async (req, res) => {
  const { session_id, prospect_id, tenant_id, selfie_key } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'Falta session_id' });
  }

  try {
    const command = new GetFaceLivenessSessionResultsCommand({
      SessionId: session_id,
    });

    const response = await rekognition.send(command);
    console.log('Resultados obtenidos:', response.Status);

    if (response.Status === 'SUCCEEDED') {
        const isLive = response.Confidence > 90;
        const livenessEvidence = getBestLivenessEvidence(response);

        if (!livenessEvidence) {
          return res.status(422).json({
            status: 'failed',
            message: 'Liveness SUCCEEDED pero no hay imagen de evidencia para comparación facial.',
          });
        }

        const faceVerification = await compareSelfieVsLiveness({
          tenant_id,
          prospect_id,
          selfie_key,
          livenessEvidence,
        });

        const approved = isLive && faceVerification.match;
        validationResultsBySession.set(session_id, {
          SessionId: session_id,
          livenessStatus: response.Status,
          livenessConfidence: response.Confidence,
          faceMatchScore: faceVerification.score,
          faceMatchThreshold: faceVerification.threshold,
          match: faceVerification.match,
          approved,
          createdAt: new Date().toISOString(),
        });

        res.json({ 
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
            full_response: response
        });
    } else {
        res.status(400).json({ status: 'failed', message: 'La validación no fue exitosa o expiró.' });
    }

  } catch (error) {
    console.error('Error obteniendo resultados:', error);
    res.status(500).json({ error: 'Error al obtener los resultados' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de Liveness corriendo en http://localhost:${PORT}`);
});

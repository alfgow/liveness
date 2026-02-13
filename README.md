# Liveness demo (frontend + backend)

Proyecto con frontend en Vite/React y backend Express para flujo de AWS Rekognition Face Liveness.

## Variables de entorno

> En Amplify Hosting, las variables **no pueden iniciar con `AWS_`**. Por eso este proyecto soporta variables alternativas para evitar ese prefijo.

### Frontend (Vite)

Estas sí deben llevar prefijo `VITE_` porque son leídas en build/browser:

- `VITE_API_BASE_URL`
- `VITE_LIVENESS_BASE_URL`
- `VITE_API_TOKEN`
- `VITE_COGNITO_IDENTITY_POOL_ID`
- `VITE_COGNITO_ALLOW_GUEST_ACCESS`
- `VITE_COGNITO_REGION`
- `VITE_REKOGNITION_REGION` (opcional, fallback a `VITE_LIVENESS_REGION`)
- `VITE_LIVENESS_ACCESS_KEY_ID` (solo si usas credenciales estáticas)
- `VITE_LIVENESS_SECRET_ACCESS_KEY` (solo si usas credenciales estáticas)
- `VITE_LIVENESS_SESSION_TOKEN` (opcional)


#### Variables adicionales de frontend soportadas

Además de las variables anteriores, el frontend también soporta estas variables opcionales:

- `VITE_AWS_ACCESS_KEY_ID` (alternativa a `VITE_LIVENESS_ACCESS_KEY_ID`)
- `VITE_AWS_SECRET_ACCESS_KEY` (alternativa a `VITE_LIVENESS_SECRET_ACCESS_KEY`)
- `VITE_AWS_SESSION_TOKEN` (alternativa a `VITE_LIVENESS_SESSION_TOKEN`)
- `VITE_AWS_REGION` (alternativa a `VITE_REKOGNITION_REGION`/`VITE_LIVENESS_REGION`)
- `VITE_LIVENESS_REGION` (fallback de región para frontend)
- `VITE_LIVENESS_AUTHORIZE_ENDPOINT` (default `/api/v1/prospectos/identidad/validate`)
- `VITE_LIVENESS_SESSION_ENDPOINT` (default `/api/liveness/session`)
- `VITE_LIVENESS_RESULT_ENDPOINT` (default `/api/liveness/result`)
- `VITE_VALIDATIONS_ENDPOINT` (default `/api/v1/inquilinos/{{id_inquilino}}/validaciones`)

> También puedes inyectar configuración en runtime con `window.__LIVENESS_CONFIG__` para sobreescribir valores de `VITE_*` sin reconstruir el frontend.

### Backend (Node/Express)

Variables para liveness + face match:

- `LIVENESS_PORT` (default `3001`)
- `REKOGNITION_REGION` (default `us-east-1`)
- `S3_SELFIE_REGION` (default `REKOGNITION_REGION`)
- `FACE_MATCH_THRESHOLD` (default `92`)
- `LIVENESS_MIN_CONFIDENCE` (default `90`, umbral de aprobación automática)
- `LIVENESS_REVIEW_MIN_CONFIDENCE` (default `85`, inicio de zona gris para revisión manual)
- `FACE_MATCH_REVIEW_MIN_THRESHOLD` (default `85`, mínimo para evitar rechazo automático por match)
- `SELFIE_BUCKET` (**requerida**, debe ser **nombre de bucket**, no ARN; ej. `my-selfies-bucket`)
- `SELFIE_KEY_TEMPLATE` (default `tenants/{tenant_id}/prospects/{prospect_id}/selfie.jpg`)
- `selfie_key` enviado desde frontend al backend: se toma de `data.selfie_key` del authorize y, si no viene, fallback a `data.s3_key`; si tampoco viene, backend usa la ruta canónica con `SELFIE_KEY_TEMPLATE`.

Variables para evidencias canónicas y trazabilidad:

- `LIVENESS_EVIDENCE_BUCKET` (**requerida para persistir evidencia canónica**, debe ser **nombre de bucket**, no ARN)
- `LIVENESS_EVIDENCE_PREFIX` (default `liveness-evidence`)
- `LIVENESS_ALGORITHM_VERSION` (default `rekognition-face-liveness-v1`)
- `LIVENESS_APPLY_LIFECYCLE_POLICY` (`true|false`, default `false`)
- `LIVENESS_EVIDENCE_RETENTION_DAYS` (si `> 0` y lifecycle habilitado, aplica borrado automático)
- `LIVENESS_EVIDENCE_KMS_KEY_ID` (opcional, KMS key específica para cifrado SSE-KMS de evidencias)
- `LIVENESS_ALLOW_SELFIE_KEY_OVERRIDE` (`true|false`, default `false`; mantener `false` para forzar selfie canónica)

Credenciales backend (orden de preferencia):

1. `LIVENESS_ACCESS_KEY_ID` + `LIVENESS_SECRET_ACCESS_KEY` (+ `LIVENESS_SESSION_TOKEN` opcional)
2. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN` opcional)
3. Si no se definen, AWS SDK intentará provider chain por defecto (IAM role, etc.)

Formato/valores esperados para credenciales:

- `*_ACCESS_KEY_ID`: string tipo Access Key ID de AWS (ej. `AKIA...` o `ASIA...` si son temporales STS).
- `*_SECRET_ACCESS_KEY`: string secreto asociado a esa Access Key.
- `*_SESSION_TOKEN`: **obligatorio** cuando usas credenciales temporales STS (`ASIA...`), opcional con credenciales de largo plazo (`AKIA...`).

¿Deben ser credenciales de usuario IAM?

- **Sí pueden ser** de un usuario IAM (Access Key + Secret), pero para producción se recomienda **no** usar llaves estáticas en variables de entorno.
- Recomendado en producción: usar **IAM Role** (EC2/ECS/Lambda/Amplify/CodeBuild) y dejar que el SDK tome credenciales por provider chain.
- Si usas llaves, deben tener permisos mínimos (least privilege) solo para Rekognition/S3/KMS requeridos por este flujo.

## Flujo de evidencia y metadata

Cuando `/api/liveness/result` devuelve `SUCCEEDED`, el backend ahora:

1. Selecciona una imagen canónica (`ReferenceImage` primero; fallback: `AuditImage` con mayor score de calidad).
2. Sube esa evidencia **desde backend** a `s3://<LIVENESS_EVIDENCE_BUCKET>/<LIVENESS_EVIDENCE_PREFIX>/<tenantId>/<sessionId>/canonical.jpg`.
3. Guarda metadatos de validación:
   - `SessionId`
   - `tenantId`
   - `timestamp`
   - `livenessConfidence`
   - `faceMatchScore`
   - `algorithmVersion`
4. Persiste en el registro de validación interno la ubicación de S3 (`bucket`, `key`) para trazabilidad.
5. Opcionalmente aplica lifecycle policy en el bucket de evidencias para retención y borrado automático.

Además, puedes consultar un registro puntual con:

- `GET /api/liveness/validation/:sessionId`


## Reglas de decisión (backend)

El backend calcula una decisión explícita por cada sesión usando `livenessStatus`, `livenessConfidence` y `faceMatchScore`:

- **Aprobar (`approved`)**: `livenessStatus = SUCCEEDED` + `livenessConfidence >= LIVENESS_MIN_CONFIDENCE` + `faceMatchScore >= FACE_MATCH_THRESHOLD`.
- **Revisión manual (`manual_review`)**: sesión exitosa pero score en zona gris (`livenessConfidence >= LIVENESS_REVIEW_MIN_CONFIDENCE` y `faceMatchScore >= FACE_MATCH_REVIEW_MIN_THRESHOLD` sin cumplir umbral de aprobación).
- **Rechazar (`rejected`)**:
  - liveness fallido (`livenessStatus != SUCCEEDED`), o
  - `faceMatchScore < FACE_MATCH_REVIEW_MIN_THRESHOLD`, o
  - confianza por debajo de umbral mínimo de revisión.

Además se registra `decision_reason` para auditoría/debugging y se expone en:

- Respuesta de `POST /api/liveness/result`.
- Registro interno consultable en `GET /api/liveness/validation/:sessionId`.
- Payload hacia API de validaciones (`liveness_process` ampliado y campos paralelos `liveness_decision`, `liveness_decision_reason`, `liveness_approved`).

## Ejemplo `.env`

```env
# Backend
LIVENESS_PORT=3001
REKOGNITION_REGION=us-east-1
S3_SELFIE_REGION=mx-central-1
SELFIE_BUCKET=my-selfies-bucket
SELFIE_KEY_TEMPLATE=tenants/{tenant_id}/prospects/{prospect_id}/selfie.jpg
FACE_MATCH_THRESHOLD=92
LIVENESS_MIN_CONFIDENCE=90
LIVENESS_EVIDENCE_BUCKET=my-evidence-bucket
LIVENESS_EVIDENCE_PREFIX=liveness-evidence
LIVENESS_ALGORITHM_VERSION=rekognition-face-liveness-v1
LIVENESS_APPLY_LIFECYCLE_POLICY=true
LIVENESS_EVIDENCE_RETENTION_DAYS=90
LIVENESS_ACCESS_KEY_ID=AKIA...
LIVENESS_SECRET_ACCESS_KEY=...

# Frontend
VITE_API_BASE_URL=https://api.example.com
VITE_LIVENESS_BASE_URL=https://liveness.example.com
VITE_COGNITO_IDENTITY_POOL_ID=us-east-1:xxxx
VITE_COGNITO_REGION=us-east-1
VITE_REKOGNITION_REGION=us-east-1
```

## Seguridad, cumplimiento y gobierno de biometría

### 1) IAM mínimo privilegio (lectura selfie + escritura evidencia en prefijo)

El backend debe usar una policy IAM **sin comodines amplios** y separada por propósito:

- `s3:GetObject` únicamente para la selfie de referencia del prospecto.
- `s3:PutObject` únicamente en `s3://<LIVENESS_EVIDENCE_BUCKET>/<LIVENESS_EVIDENCE_PREFIX>/*`.
- `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey` y `kms:DescribeKey` únicamente sobre la KMS key configurada.

Ejemplo orientativo:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadReferenceSelfieOnly",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::<SELFIE_BUCKET>/tenants/*/prospects/*/selfie.jpg"
    },
    {
      "Sid": "WriteEvidencePrefixOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::<LIVENESS_EVIDENCE_BUCKET>/<LIVENESS_EVIDENCE_PREFIX>/*"
    },
    {
      "Sid": "UseKmsForEvidenceOnly",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>"
    }
  ]
}
```

### 2) Cifrado S3 y no exposición pública

El backend carga evidencia con `ServerSideEncryption: aws:kms` y opcionalmente `SSEKMSKeyId` con `LIVENESS_EVIDENCE_KMS_KEY_ID`.

Además:

- Mantén habilitado `S3 Block Public Access` en los buckets de selfie y evidencia.
- No generar presigned URLs públicas para imágenes biométricas.
- El API devuelve solo `bucket` y `key` para trazabilidad; no expone URL pública.

### 3) Correlación de logs por SessionId y tenantId

Se implementó logging estructurado JSON con campos:

- `event`
- `SessionId`
- `tenantId`
- `timestamp`

Y se evita volcar datos biométricos sensibles en logs (bytes/imágenes/full payload).

### 4) Retención y borrado de biometría

Para evidencias en S3:

- `LIVENESS_APPLY_LIFECYCLE_POLICY=true`
- `LIVENESS_EVIDENCE_RETENTION_DAYS=<días>`

La policy aplicada considera:

- `Expiration` para versiones actuales
- `NoncurrentVersionExpiration` para versiones no actuales
- `AbortIncompleteMultipartUpload` a 7 días

Recomendación de cumplimiento:

- Definir retención diferenciada para aprobados/rechazados según contrato y base legal.
- Registrar en DPIA/ROPA la temporalidad y justificación.
- Asegurar borrado en backups y réplicas según SLA.

### 5) Consentimiento y finalidad del tratamiento

Debes documentar (y conservar evidencia de) consentimiento explícito del usuario final antes del flujo biométrico:

- Finalidad específica (validación de vida y prevención de fraude).
- Base legal aplicable.
- Tiempo de conservación.
- Mecanismo de revocación y derechos ARCO/GDPR equivalentes.
- Terceros/proveedores involucrados (ej. AWS Rekognition).

Recomendado: almacenar `consent_version`, `consent_timestamp`, `tenant_id`, `prospect_id` y huella del texto aceptado.


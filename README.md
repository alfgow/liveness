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

### Backend (Node/Express)

Variables para liveness + face match:

- `LIVENESS_PORT` (default `3001`)
- `REKOGNITION_REGION` (default `us-east-1`)
- `S3_SELFIE_REGION` (default `REKOGNITION_REGION`)
- `FACE_MATCH_THRESHOLD` (default `92`)
- `LIVENESS_MIN_CONFIDENCE` (default `90`, umbral de aprobación automática)
- `LIVENESS_REVIEW_MIN_CONFIDENCE` (default `85`, inicio de zona gris para revisión manual)
- `FACE_MATCH_REVIEW_MIN_THRESHOLD` (default `85`, mínimo para evitar rechazo automático por match)
- `SELFIE_BUCKET` (**requerida**)
- `SELFIE_KEY_TEMPLATE` (default `tenants/{tenant_id}/prospects/{prospect_id}/selfie.jpg`)

Variables para evidencias canónicas y trazabilidad:

- `LIVENESS_EVIDENCE_BUCKET` (**requerida para persistir evidencia canónica**)
- `LIVENESS_EVIDENCE_PREFIX` (default `liveness-evidence`)
- `LIVENESS_ALGORITHM_VERSION` (default `rekognition-face-liveness-v1`)
- `LIVENESS_APPLY_LIFECYCLE_POLICY` (`true|false`, default `false`)
- `LIVENESS_EVIDENCE_RETENTION_DAYS` (si `> 0` y lifecycle habilitado, aplica borrado automático)

Credenciales backend (orden de preferencia):

1. `LIVENESS_ACCESS_KEY_ID` + `LIVENESS_SECRET_ACCESS_KEY` (+ `LIVENESS_SESSION_TOKEN` opcional)
2. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN` opcional)
3. Si no se definen, AWS SDK intentará provider chain por defecto (IAM role, etc.)

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
4. Persiste en el registro de validación interno la ubicación de S3 (`bucket`, `key`, `s3Uri`) para trazabilidad.
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

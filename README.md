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
- `SELFIE_BUCKET` (**requerida**)
- `SELFIE_KEY_TEMPLATE` (default `tenants/{tenant_id}/prospects/{prospect_id}/selfie.jpg`)

Credenciales backend (orden de preferencia):

1. `LIVENESS_ACCESS_KEY_ID` + `LIVENESS_SECRET_ACCESS_KEY` (+ `LIVENESS_SESSION_TOKEN` opcional)
2. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN` opcional)
3. Si no se definen, AWS SDK intentará provider chain por defecto (IAM role, etc.)

## Ejemplo `.env`

```env
# Backend
LIVENESS_PORT=3001
REKOGNITION_REGION=us-east-1
S3_SELFIE_REGION=mx-central-1
SELFIE_BUCKET=my-selfies-bucket
SELFIE_KEY_TEMPLATE=tenants/{tenant_id}/prospects/{prospect_id}/selfie.jpg
FACE_MATCH_THRESHOLD=92
LIVENESS_ACCESS_KEY_ID=AKIA...
LIVENESS_SECRET_ACCESS_KEY=...

# Frontend
VITE_API_BASE_URL=https://api.example.com
VITE_LIVENESS_BASE_URL=https://liveness.example.com
VITE_COGNITO_IDENTITY_POOL_ID=us-east-1:xxxx
VITE_COGNITO_REGION=us-east-1
VITE_REKOGNITION_REGION=us-east-1
```

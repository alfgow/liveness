import {
    CreateFaceLivenessSessionCommand,
    GetFaceLivenessSessionResultsCommand,
    RekognitionClient
} from '@aws-sdk/client-rekognition';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const app = express();
const PORT = process.env.LIVENESS_PORT || 3001;

// Configurar CORS
// Esto es importante para que el frontend local (e.g. localhost:5174) pueda comunicarse
app.use(cors());
app.use(express.json());

// Configurar AWS Client
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

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
      region: process.env.AWS_REGION || 'us-east-1',
    });
  } catch (error) {
    console.error('Error creando sesión:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Error al crear la sesión de liveness', details: error.message });
  }
});

// Endpoint: Guardar/Obtener resultados
app.post('/api/liveness/result', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'Falta session_id' });
  }

  try {
    const command = new GetFaceLivenessSessionResultsCommand({
      SessionId: session_id,
    });

    const response = await rekognition.send(command);
    console.log('Resultados obtenidos:', response.Status);

    // Aquí podrías agregar lógica adicional:
    // 1. Guardar la imagen de referencia (response.ReferenceImage.Bytes) en S3
    // 2. Validar el confidence score (response.Confidence)
    // 3. Notificar a tu backend principal que la validación fue exitosa

    if (response.Status === 'SUCCEEDED') {
        const isLive = response.Confidence > 90; // Umbral de confianza
        res.json({ 
            status: 'success', 
            live: isLive,
            confidence: response.Confidence,
            full_response: response // Para debugging por ahora
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

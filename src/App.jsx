import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness'
import {
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition'
import { Amplify } from 'aws-amplify'
import { fetchAuthSession } from 'aws-amplify/auth'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

function App() {
  const [error, setError] = useState('')
  const [status, setStatus] = useState('idle')
  const [session, setSession] = useState(null)
  const [token, setToken] = useState('')
  const [credentials, setCredentials] = useState(null)
  const [showDetector, setShowDetector] = useState(false)
  const analysisCompleteRef = useRef(false)

  const config = useMemo(() => {
    const runtimeConfig = window.__LIVENESS_CONFIG__ ?? {}
    const awsAccessKeyId =
      runtimeConfig.awsAccessKeyId ??
      import.meta.env.VITE_AWS_ACCESS_KEY_ID ??
      import.meta.env.AWS_ACCESS_KEY_ID ??
      ''
    const awsSecretAccessKey =
      runtimeConfig.awsSecretAccessKey ??
      import.meta.env.VITE_AWS_SECRET_ACCESS_KEY ??
      import.meta.env.AWS_SECRET_ACCESS_KEY ??
      ''
    const awsSessionToken =
      runtimeConfig.awsSessionToken ??
      import.meta.env.VITE_AWS_SESSION_TOKEN ??
      import.meta.env.AWS_SESSION_TOKEN ??
      ''
    const awsRegion =
      runtimeConfig.awsRegion ??
      import.meta.env.VITE_AWS_REGION ??
      import.meta.env.AWS_REGION ??
      ''

    return {
      apiBaseUrl: runtimeConfig.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '',
      livenessBaseUrl: runtimeConfig.livenessBaseUrl ?? import.meta.env.VITE_LIVENESS_BASE_URL ?? '',
      apiToken: runtimeConfig.apiToken ?? import.meta.env.VITE_API_TOKEN ?? '',
      authorizeEndpoint:
        runtimeConfig.authorizeEndpoint ??
        import.meta.env.VITE_LIVENESS_AUTHORIZE_ENDPOINT ??
        '/api/v1/prospectos/identidad/validate',
      sessionEndpoint:
        runtimeConfig.sessionEndpoint ??
        import.meta.env.VITE_LIVENESS_SESSION_ENDPOINT ??
        '/api/liveness/session',
      resultEndpoint:
        runtimeConfig.resultEndpoint ??
        import.meta.env.VITE_LIVENESS_RESULT_ENDPOINT ??
        '/api/liveness/result',
      amplifyConfig: runtimeConfig.amplifyConfig ?? {
        Auth: {
          Cognito: {
            identityPoolId:
              runtimeConfig.identityPoolId ??
              import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID ??
              '',
            allowGuestAccess:
              runtimeConfig.allowGuestAccess ??
              (import.meta.env.VITE_COGNITO_ALLOW_GUEST_ACCESS ?? 'true') !== 'false',
            region:
              runtimeConfig.cognitoRegion ??
              import.meta.env.VITE_COGNITO_REGION ??
              runtimeConfig.region ??
              import.meta.env.VITE_LIVENESS_REGION ??
              '',
          },
        },
      },
      awsCredentials:
        awsAccessKeyId && awsSecretAccessKey
          ? {
              accessKeyId: awsAccessKeyId,
              secretAccessKey: awsSecretAccessKey,
              sessionToken: awsSessionToken || undefined,
            }
          : null,
      awsRegion,
    }
  }, [])

  useEffect(() => {
    const { pathname, search, hash } = window.location
    const pathSegments = pathname.split('/').filter(Boolean)
    const pathToken = pathSegments.length ? pathSegments[pathSegments.length - 1].trim() : ''
    const urlToken = new URLSearchParams(search).get('token')
    const hashToken = hash.startsWith('#') ? hash.slice(1).replace(/^\//, '') : ''
    const resolvedToken =
      pathToken && pathToken !== 'index.html'
        ? pathToken
        : urlToken || hashToken

    if (!resolvedToken) {
      setError('No se encontró el token en la URL.')
      return
    }

    setToken(resolvedToken)
  }, [])

  useEffect(() => {
    if (!token) {
      return
    }

    const identityPoolId = config.amplifyConfig?.Auth?.Cognito?.identityPoolId
    const region = config.amplifyConfig?.Auth?.Cognito?.region || config.awsRegion

    if (config.awsCredentials && region) {
      setCredentials({ ...config.awsCredentials, region })
      return
    }

    if (!identityPoolId || !region) {
      setError('Falta configurar identityPoolId o region, o credenciales AWS válidas.')
      return
    }

    Amplify.configure(config.amplifyConfig)
  }, [config, token])

  useEffect(() => {
    if (status === 'ready') {
      setShowDetector(true)
    }
  }, [status])

  useEffect(() => {
    analysisCompleteRef.current = false
  }, [session?.sessionId])

  useEffect(() => {
    if (!token || error) {
      return
    }

    const authorize = async () => {
      if (!config.authorizeEndpoint) {
        return { status: 'success' }
      }

      const authorizeUrl = buildEndpoint(config.authorizeEndpoint, token, config.apiBaseUrl)

      const headers = { 'Content-Type': 'application/json' }
      if (config.apiToken) {
        headers['Authorization'] = `Bearer ${config.apiToken}`
      }

      const response = await fetch(authorizeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token }),
      })

      if (!response.ok) {
        throw new Error('No se pudo autorizar el acceso.')
      }

      return response.json()
    }

    const createSession = async () => {
      setStatus('loading')
      const authorizeResult = await authorize()

      if (authorizeResult?.status && authorizeResult.status !== 'success') {
        throw new Error(authorizeResult?.message ?? 'Token inválido o expirado.')
      }

      const resolvedCredentials = await getCredentials(config, credentials)

      const rekognitionClient = new RekognitionClient({
        region:
          resolvedCredentials.region ||
          config.amplifyConfig?.Auth?.Cognito?.region ||
          config.awsRegion,
        credentials: {
          accessKeyId: resolvedCredentials.accessKeyId,
          secretAccessKey: resolvedCredentials.secretAccessKey,
          sessionToken: resolvedCredentials.sessionToken,
        },
      })

      const command = new CreateFaceLivenessSessionCommand({})
      const response = await rekognitionClient.send(command)

      if (!response?.SessionId) {
        throw new Error('La respuesta de sesión no incluye session_id.')
      }

      setSession({
        sessionId: response.SessionId,
        region:
          resolvedCredentials.region ||
          config.amplifyConfig?.Auth?.Cognito?.region ||
          config.awsRegion,
      })
      setStatus('ready')
    }

    createSession().catch((err) => {
      setError(err.message ?? 'Ocurrió un error al crear la sesión.')
      setStatus('error')
    })
  }, [config, token, error, credentials])

  const handleAnalysisComplete = async () => {
    if (!session) {
      return
    }

    if (analysisCompleteRef.current) {
      return
    }

    analysisCompleteRef.current = true

    try {
      setStatus('saving')
      const resolvedCredentials = await getCredentials(config, credentials)

      const rekognitionClient = new RekognitionClient({
        region: session.region || resolvedCredentials.region || config.awsRegion,
        credentials: {
          accessKeyId: resolvedCredentials.accessKeyId,
          secretAccessKey: resolvedCredentials.secretAccessKey,
          sessionToken: resolvedCredentials.sessionToken,
        },
      })

      const command = new GetFaceLivenessSessionResultsCommand({
        SessionId: session.sessionId,
      })
      const result = await rekognitionClient.send(command)

      if (result?.Status === 'SUCCEEDED') {
        setStatus('completed')
        setShowDetector(false)
        return
      }

      throw new Error('La validación no fue exitosa o expiró.')
    } catch (err) {
      setError(err.message ?? 'No se pudo guardar el resultado.')
      setStatus('error')
      setShowDetector(false)
    }
  }

  const handleError = (livenessError) => {
    setError(livenessError?.message ?? 'Error durante la sesión de Liveness.')
    setStatus('error')
    setShowDetector(false)
  }

  const livenessDisplayText = useMemo(
    () => ({
      a11yVideoLabelText: 'Cámara para validación de vida',
      cancelLivenessCheckText: 'Cancelar validación de vida',
      cameraMinSpecificationsHeadingText: 'La cámara no cumple con los requisitos mínimos',
      cameraMinSpecificationsMessageText:
        'La cámara debe soportar al menos 320x240 de resolución y 15 cuadros por segundo.',
      cameraNotFoundHeadingText: 'No se puede acceder a la cámara.',
      cameraNotFoundMessageText:
        'Verifica que la cámara esté conectada y que ninguna otra aplicación la esté usando. Puede que debas otorgar permisos de cámara en la configuración y reiniciar el navegador.',
      retryCameraPermissionsText: 'Reintentar',
      waitingCameraPermissionText: 'Esperando tu permiso para usar la cámara.',
      goodFitCaptionText: 'Buen encuadre',
      goodFitAltText: 'Ilustración de un rostro que encaja perfectamente dentro del óvalo.',
      tooFarCaptionText: 'Demasiado lejos',
      tooFarAltText:
        'Ilustración de un rostro dentro del óvalo con espacio entre la cara y el óvalo.',
      startScreenBeginCheckText: 'Iniciar validación en video',
      hintCenterFaceText: 'Centra tu rostro',
      hintCenterFaceInstructionText:
        'Antes de iniciar, coloca la cámara al centro superior de la pantalla y centra tu rostro. Cuando comience la validación aparecerá un óvalo; acércate hasta llenarlo y luego permanece quieto.',
      hintFaceOffCenterText: 'Tu rostro no está en el óvalo, céntralo.',
      hintMoveFaceFrontOfCameraText: 'Coloca el rostro frente a la cámara',
      hintTooManyFacesText: 'Asegúrate de que solo haya un rostro frente a la cámara',
      hintFaceDetectedText: 'Rostro detectado',
      hintCanNotIdentifyText: 'Coloca el rostro frente a la cámara',
      hintTooCloseText: 'Aléjate un poco',
      hintTooFarText: 'Acércate un poco',
      hintConnectingText: 'Conectando...',
      hintVerifyingText: 'Verificando...',
      hintCheckCompleteText: 'Validación completa',
      hintIlluminationTooBrightText: 'Muévete a un área con menos luz',
      hintIlluminationTooDarkText: 'Muévete a un área con más luz',
      hintIlluminationNormalText: 'La iluminación es adecuada',
      hintHoldFaceForFreshnessText: 'Quédate quieto',
      hintMatchIndicatorText: '50% completado. Sigue acercándote.',
      recordingIndicatorText: 'Rec',
      photosensitivityWarningHeadingText: 'Advertencia de fotosensibilidad',
      photosensitivityWarningBodyText:
        'Esta validación muestra colores intermitentes. Ten precaución si eres fotosensible.',
      photosensitivityWarningInfoText:
        'Algunas personas pueden experimentar convulsiones al exponerse a luces de colores. Ten precaución si tú o alguien en tu familia tiene epilepsia.',
      photosensitivityWarningLabelText: 'Más información sobre fotosensibilidad',
      errorLabelText: 'Error',
      connectionTimeoutHeaderText: 'Tiempo de conexión agotado',
      connectionTimeoutMessageText: 'La conexión expiró.',
      timeoutHeaderText: 'Tiempo agotado',
      timeoutMessageText:
        'Tu rostro no se ajustó al óvalo a tiempo. Intenta de nuevo y llena el óvalo con tu rostro.',
      faceDistanceHeaderText: 'Se detectó movimiento hacia adelante',
      faceDistanceMessageText: 'Evita acercarte al conectar.',
      multipleFacesHeaderText: 'Se detectaron varios rostros',
      multipleFacesMessageText:
        'Asegúrate de que solo haya un rostro frente a la cámara al conectar.',
      clientHeaderText: 'Error del cliente',
      clientMessageText: 'La validación falló por un problema del cliente.',
      serverHeaderText: 'Error del servidor',
      serverMessageText: 'No se pudo completar la validación por un problema del servidor.',
      landscapeHeaderText: 'La orientación horizontal no es compatible',
      landscapeMessageText: 'Gira tu dispositivo a orientación vertical.',
      portraitMessageText:
        'Asegúrate de mantener el dispositivo en orientación vertical durante la validación.',
      tryAgainText: 'Intentar de nuevo',
    }),
    []
  )

  return (
    <div className="min-h-screen bg-brand-surface py-12 px-4">
      <div className="container mx-auto max-w-4xl">
        
        {/* Brand Header */}
        <div className="liveness-header-brand">
          <div className="brand-logo-container">
            <img 
              src="https://alfgow.s3.mx-central-1.amazonaws.com/Logo+Circular.png" 
              alt="Arrendamiento Seguro" 
              className="brand-logo"
            />
            <div className="brand-title">
              <span className="brand-name">ARRENDAMIENTO</span>
              <span className="brand-suffix">SEGURO</span>
            </div>
          </div>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2rem shadow-soft border border-brand-accent-20 overflow-hidden">
          
          {/* Card Header */}
          <div className="card-header">
            <h1 className="card-title">Comprobación de vida</h1>
            <p className="card-subtitle">
              Sigue las instrucciones en pantalla para completar la validación de tu identidad.
            </p>
          </div>

          {/* Card Content */}
          <div className="liveness-content">
            <div className="liveness-container">
              {error ? <div className="liveness-error">{error}</div> : null}

              {!error && status === 'loading' ? (
                <div className="liveness-status">Preparando sesión segura...</div>
              ) : null}

              {!error && status === 'saving' ? (
                <div className="liveness-status">Guardando resultado...</div>
              ) : null}

              {!error && status === 'completed' ? (
                <div className="liveness-success">
                  ✅ Validación completada exitosamente. Puedes cerrar esta ventana.
                </div>
              ) : null}

              {session && showDetector && !error && status !== 'completed' && status !== 'saving' ? (
                <FaceLivenessDetector
                  sessionId={session.sessionId}
                  region={session.region}
                  onAnalysisComplete={handleAnalysisComplete}
                  onError={handleError}
                  displayText={livenessDisplayText}
                  config={{
                    credentialProvider: config.awsCredentials
                      ? async () => ({
                          accessKeyId: config.awsCredentials.accessKeyId,
                          secretAccessKey: config.awsCredentials.secretAccessKey,
                          sessionToken: config.awsCredentials.sessionToken,
                        })
                      : config.amplifyConfig.Auth,
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

const getCredentials = async (config, cachedCredentials) => {
  if (cachedCredentials) {
    return cachedCredentials
  }

  if (config.awsCredentials) {
    return { ...config.awsCredentials, region: config.awsRegion }
  }

  const { credentials } = await fetchAuthSession()
  if (!credentials) {
    throw new Error('No se pudieron obtener credenciales de AWS.')
  }

  return credentials
}

const buildEndpoint = (endpoint, token, apiBaseUrl) => {
  if (!endpoint) {
    return ''
  }

  const normalized = endpoint.replace('{token}', token).replace(':token', token)

  if (normalized.startsWith('http')) {
    return normalized
  }

  return `${apiBaseUrl ?? ''}${normalized}`
}

export default App

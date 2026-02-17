import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness'
import { CreateFaceLivenessSessionCommand, RekognitionClient } from '@aws-sdk/client-rekognition'
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
  const [tenantId, setTenantId] = useState(null)
  const [prospectId, setProspectId] = useState(null)
  const [selfieKey, setSelfieKey] = useState('')
  const analysisCompleteRef = useRef(false)

  const config = useMemo(() => {
    const runtimeConfig = window.__LIVENESS_CONFIG__ ?? {}
    const awsAccessKeyId =
      runtimeConfig.awsAccessKeyId ??
      import.meta.env.VITE_AWS_ACCESS_KEY_ID ??
      import.meta.env.VITE_LIVENESS_ACCESS_KEY_ID ??
      ''
    const awsSecretAccessKey =
      runtimeConfig.awsSecretAccessKey ??
      import.meta.env.VITE_AWS_SECRET_ACCESS_KEY ??
      import.meta.env.VITE_LIVENESS_SECRET_ACCESS_KEY ??
      ''
    const awsSessionToken =
      runtimeConfig.awsSessionToken ??
      import.meta.env.VITE_AWS_SESSION_TOKEN ??
      import.meta.env.VITE_LIVENESS_SESSION_TOKEN ??
      ''
    const awsRegion =
      runtimeConfig.awsRegion ??
      import.meta.env.VITE_AWS_REGION ??
      import.meta.env.VITE_REKOGNITION_REGION ??
      import.meta.env.VITE_LIVENESS_REGION ??
      ''

    return {
      apiBaseUrl: runtimeConfig.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '',
      livenessBaseUrl:
        runtimeConfig.livenessBaseUrl ??
        import.meta.env.VITE_LIVENESS_BASE_URL ??
        runtimeConfig.apiBaseUrl ??
        import.meta.env.VITE_API_BASE_URL ??
        '',
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
      validationsEndpoint:
        runtimeConfig.validationsEndpoint ??
        import.meta.env.VITE_VALIDATIONS_ENDPOINT ??
        '/api/v1/inquilinos/{{id_inquilino}}/validaciones',
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
      urlToken ||
      hashToken ||
      (pathToken && pathToken !== 'index.html' ? pathToken : '')

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
      const resolvedTenantId = authorizeResult?.data?.actor_id
      const resolvedProspectId = authorizeResult?.data?.prospect_id ?? authorizeResult?.data?.id
      const resolvedSelfieKey =
        authorizeResult?.data?.selfie_key ??
        authorizeResult?.data?.s3_key ??
        ''

      if (authorizeResult?.status && authorizeResult.status !== 'success') {
        throw new Error(authorizeResult?.message ?? 'Token inválido o expirado.')
      }

      if (!resolvedTenantId) {
        throw new Error('No se encontró actor_id (id_inquilino) en la respuesta de autorización.')
      }

      setTenantId(resolvedTenantId)
      setProspectId(resolvedProspectId ?? null)
      setSelfieKey(resolvedSelfieKey)

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
    if (!session || !tenantId) {
      return
    }

    if (analysisCompleteRef.current) {
      return
    }

    analysisCompleteRef.current = true

    try {
      setStatus('saving')

      const livenessResult = await getBackendLivenessResult({
        config,
        sessionId: session.sessionId,
        tenantId,
        prospectId,
        selfieKey,
      })

      const data = livenessResult?.data || {}
      const decision = data.liveness_decision || {}

      // Validar si el proceso técnico (AWS) fue exitoso
      if (data.status === 'SUCCEEDED') {
        // Validar si la decisión de negocio fue aprobada
        if (decision.approved) {
          setStatus('completed')
          setShowDetector(false)
          return
        }

        // Manejo de casos de rechazo específicos con mensajes amigables
        if (decision.code === 'liveness_passed_face_mismatch') {
          throw new Error('Validación de vida exitosa, pero tu rostro no coincide con la foto de referencia. Por favor contacta a tu asesor de arrendamientoseguro.app.')
        }

        // Mensaje genérico o el que venga del backend si no es un código conocido
        throw new Error(decision.message || 'No pudimos validar tu identidad. Por favor intenta nuevamente.')
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

  const credentialProvider = async () => {
    const resolvedCredentials = await getCredentials(config, credentials)

    return {
      accessKeyId: resolvedCredentials.accessKeyId,
      secretAccessKey: resolvedCredentials.secretAccessKey,
      sessionToken: resolvedCredentials.sessionToken,
    }
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

  const isDetectorView = !error && showDetector && status !== 'completed' && status !== 'saving' && Boolean(session)

  return (
    <div
      className={`min-h-screen bg-brand-surface py-12 px-4 liveness-page ${
        isDetectorView ? 'liveness-page--detector' : ''
      }`}
    >
      <div className="container mx-auto max-w-4xl">
        
        {/* Brand Header */}
        <div className={`liveness-header-brand ${isDetectorView ? 'liveness-header-brand--compact' : ''}`}>
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
          <div className={`card-header ${isDetectorView ? 'card-header--compact' : ''}`}>
            <h1 className="card-title">Comprobación de vida</h1>
            <p className={`card-subtitle ${isDetectorView ? 'card-subtitle--hidden' : ''}`}>
              Sigue las instrucciones en pantalla para completar la validación de tu identidad.
            </p>
          </div>

          {/* Card Content */}
          <div className={`liveness-content ${isDetectorView ? 'liveness-content--compact' : ''}`}>
            <div className="liveness-container">
              {error ? <div className="liveness-error">{error}</div> : null}

              {!error && status === 'loading' ? (
                <div className="liveness-status">Preparando sesión segura...</div>
              ) : null}

              {!error && status === 'saving' ? (
                <div className="liveness-status">Guardando resultado...</div>
              ) : null}

              {!error && status === 'ready' && !showDetector ? (
                <div className="liveness-start-card">
                  <p className="liveness-start-copy">
                    Todo está listo. Presiona el botón para iniciar tu validación en video.
                  </p>
                  <button
                    type="button"
                    className="liveness-start-button"
                    onClick={() => setShowDetector(true)}
                  >
                    Iniciar validación en video
                  </button>
                </div>
              ) : null}

              {!error && status === 'completed' ? (
                <div className="liveness-success">
                  <div style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>🎉</div>
                  <h3 style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>¡Identidad Validada!</h3>
                  <p>El proceso se completó exitosamente. Ya puedes cerrar esta ventana.</p>
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
                    credentialProvider,
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

  return joinBaseAndPath(apiBaseUrl, normalized)
}

const joinBaseAndPath = (baseUrl, path) => {
  const safePath = path ?? ''
  if (!baseUrl) {
    return safePath
  }

  const trimmedBaseUrl = String(baseUrl).replace(/\/+$/, '')
  const trimmedPath = String(safePath).replace(/^\/+/, '')

  if (!trimmedPath) {
    return trimmedBaseUrl
  }

  return `${trimmedBaseUrl}/${trimmedPath}`
}

const getBaseUrlFromEndpoint = (endpoint) => {
  if (!endpoint || !String(endpoint).startsWith('http')) {
    return ''
  }

  try {
    return new URL(endpoint).origin
  } catch {
    return ''
  }
}

const stripTrailingSlash = (value) => String(value ?? '').replace(/\/+((\?|#).*)?$/, '$1')

const resolveLivenessBaseUrl = (config) => {
  return (
    config?.livenessBaseUrl ||
    config?.apiBaseUrl ||
    getBaseUrlFromEndpoint(config?.resultEndpoint) ||
    getBaseUrlFromEndpoint(config?.authorizeEndpoint) ||
    ''
  )
}

const resolveApiBaseUrl = (config) => {
  return (
    config?.apiBaseUrl ||
    getBaseUrlFromEndpoint(config?.validationsEndpoint) ||
    getBaseUrlFromEndpoint(config?.authorizeEndpoint) ||
    ''
  )
}


const buildValidationsEndpoint = (config, tenantId) => {
  if (!tenantId || !config?.validationsEndpoint) {
    return ''
  }

  const endpointWithId = config.validationsEndpoint
    .replace('{{id_inquilino}}', String(tenantId))
    .replace('{id_inquilino}', String(tenantId))
    .replace(':id_inquilino', String(tenantId))

  if (endpointWithId.startsWith('http')) {
    return endpointWithId
  }

  return joinBaseAndPath(resolveApiBaseUrl(config), endpointWithId)
}

const persistValidation = async (config, tenantId, result) => {
  const validationsUrl = buildValidationsEndpoint(config, tenantId)

  if (!validationsUrl) {
    throw new Error('No se encontró el endpoint para persistir validaciones.')
  }

  const headers = { 'Content-Type': 'application/json' }
  if (config.apiToken) {
    headers.Authorization = `Bearer ${config.apiToken}`
  }

  const payload = {
    liveness_process: JSON.stringify({
      AuditImages: result?.full_response?.AuditImages ?? [],
      Challenge: {
        Type: result?.full_response?.Challenge?.Type ?? 'FaceMovementAndLightChallenge',
        Version: result?.full_response?.Challenge?.Version ?? '2.0.0',
      },
      Confidence: result?.confidence,
      SessionId: result?.face_verification?.session_id,
      Status: result?.full_response?.Status,
      decision: result?.decision,
      decision_reason: result?.decision_reason,
      approved: result?.approved,
      face_verification: result?.face_verification,
      metadata: result?.metadata,
      evidence: result?.evidence,
    }),
    liveness_decision: result?.decision ?? null,
    liveness_decision_reason: result?.decision_reason ?? null,
    liveness_approved: result?.approved ?? null,
  }

  const response = await fetch(validationsUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error('No se pudo persistir el resultado de liveness.')
  }
}

const getBackendLivenessResult = async ({ config, sessionId, tenantId }) => {
  const baseUrl = resolveApiBaseUrl(config)
  const resultUrl = `${baseUrl}/api/v1/inquilinos/${tenantId}/liveness/result/${sessionId}`

  const headers = { 'Content-Type': 'application/json' }
  if (config.apiToken) {
    headers.Authorization = `Bearer ${config.apiToken}`
  }

  const response = await fetch(resultUrl, {
    method: 'GET',
    headers,
  })

  if (!response.ok) {
    throw new Error('No se pudo recuperar el resultado desde el backend.')
  }

  return response.json()
}

export default App

import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness'
import { Amplify } from 'aws-amplify'
import { useEffect, useMemo, useState } from 'react'
import './App.css'

function App() {
  const [error, setError] = useState('')
  const [status, setStatus] = useState('idle')
  const [session, setSession] = useState(null)
  const [token, setToken] = useState('')

  const config = useMemo(() => {
    const runtimeConfig = window.__LIVENESS_CONFIG__ ?? {}

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
            region:
              runtimeConfig.cognitoRegion ??
              import.meta.env.VITE_COGNITO_REGION ??
              runtimeConfig.region ??
              import.meta.env.VITE_LIVENESS_REGION ??
              '',
          },
        },
      },
    }
  }, [])

  useEffect(() => {
    const urlToken = new URLSearchParams(window.location.search).get('token')

    if (!urlToken) {
      setError('No se encontró el token en la URL.')
      return
    }

    setToken(urlToken)
  }, [])

  useEffect(() => {
    if (!token) {
      return
    }

    const identityPoolId = config.amplifyConfig?.Auth?.Cognito?.identityPoolId
    const region = config.amplifyConfig?.Auth?.Cognito?.region

    if (!identityPoolId || !region) {
      setError('Falta configurar identityPoolId o region para Amplify.')
      return
    }

    Amplify.configure(config.amplifyConfig)
  }, [config, token])

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

      const sessionUrl = buildEndpoint(config.sessionEndpoint, token, config.livenessBaseUrl)
      const response = await fetch(sessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      if (!response.ok) {
        throw new Error('No se pudo iniciar la sesión de Liveness.')
      }

      const data = await response.json()

      if (!data?.session_id) {
        throw new Error('La respuesta de sesión no incluye session_id.')
      }

      setSession({
        sessionId: data.session_id,
        region: data.region ?? config.amplifyConfig?.Auth?.Cognito?.region,
      })
      setStatus('ready')
    }

    createSession().catch((err) => {
      setError(err.message ?? 'Ocurrió un error al crear la sesión.')
      setStatus('error')
    })
  }, [config, token, error])

  const handleAnalysisComplete = async () => {
    if (!session) {
      return
    }

    try {
      setStatus('saving')
      const resultUrl = buildEndpoint(config.resultEndpoint, token, config.livenessBaseUrl)
      const response = await fetch(resultUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          session_id: session.sessionId,
        }),
      })

      if (!response.ok) {
        throw new Error('No se pudo guardar el resultado de Liveness.')
      }

      setStatus('completed')
    } catch (err) {
      setError(err.message ?? 'No se pudo guardar el resultado.')
      setStatus('error')
    }
  }

  const handleError = (livenessError) => {
    setError(livenessError?.message ?? 'Error durante la sesión de Liveness.')
    setStatus('error')
  }

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

              {!error && status === 'ready' && session ? (
                <FaceLivenessDetector
                  sessionId={session.sessionId}
                  region={session.region}
                  onAnalysisComplete={handleAnalysisComplete}
                  onError={handleError}
                  config={{
                    credentialProvider: config.amplifyConfig.Auth
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

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
      authorizeEndpoint:
        runtimeConfig.authorizeEndpoint ??
        import.meta.env.VITE_LIVENESS_AUTHORIZE_ENDPOINT ??
        '/api/liveness/authorize',
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
      const response = await fetch(authorizeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      const sessionUrl = buildEndpoint(config.sessionEndpoint, token, config.apiBaseUrl)
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
      const resultUrl = buildEndpoint(config.resultEndpoint, token, config.apiBaseUrl)
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
    <div className="liveness-shell">
      <header className="liveness-header">
        <p className="liveness-eyebrow">Validación de identidad</p>
        <h1>Comprobación de vida</h1>
        <p className="liveness-subtitle">
          Sigue las instrucciones en pantalla para completar la validación.
        </p>
      </header>

      {error ? <div className="liveness-alert">{error}</div> : null}

      {!error && status === 'loading' ? (
        <div className="liveness-status">Preparando sesión...</div>
      ) : null}

      {!error && status === 'saving' ? (
        <div className="liveness-status">Guardando resultado...</div>
      ) : null}

      {!error && status === 'completed' ? (
        <div className="liveness-success">
          ✅ Validación completada. Puedes cerrar esta ventana.
        </div>
      ) : null}

      {!error && status === 'ready' && session ? (
        <FaceLivenessDetector
          sessionId={session.sessionId}
          region={session.region}
          onAnalysisComplete={handleAnalysisComplete}
          onError={handleError}
        />
      ) : null}
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

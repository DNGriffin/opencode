// @refresh reload
import { render } from "solid-js/web"
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@opencode-ai/app"
import { showToast } from "@opencode-ai/ui/toast"
import { requestPermissions } from "@tauri-apps/api/core"
import { impactFeedback, notificationFeedback } from "@tauri-apps/plugin-haptics"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Store } from "@tauri-apps/plugin-store"
import { bridge } from "./bridge"
import { createTauriStorage } from "./storage"
import { VoiceInputOverlay } from "./voice-input"
import { Onboarding } from "./onboarding"
import pkg from "../package.json"

type VoiceState = "prewarming" | "ready" | "recording" | "processing" | "error"
type VoiceStatus = {
  state: VoiceState
  ready: boolean
  message?: string
}
type VoiceStartResult = {
  ok: boolean
  code?: string
  message?: string
}
type VoiceStopResult = {
  text: string
  code?: string
  message?: string
}

const SETTINGS_STORE = "opencode.settings.dat"
const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
const DEFAULT_SERVER_USERNAME_KEY = "defaultServerUsername"
const DEFAULT_SERVER_PASSWORD_KEY = "defaultServerPassword"
const DEFAULT_SERVER_DISPLAY_NAME_KEY = "defaultServerDisplayName"
const settingsStore = Store.load(SETTINGS_STORE)

type ServerConfig = { url: string; displayName?: string; username?: string; password?: string }

const normalizeServerUrl = (input: string) => {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

const getDefaultServerConfig = async (): Promise<ServerConfig | null> => {
  const store = await settingsStore
  const url = await store.get(DEFAULT_SERVER_URL_KEY).catch(() => null)
  if (typeof url !== "string") return null
  const displayName = await store.get(DEFAULT_SERVER_DISPLAY_NAME_KEY).catch(() => null)
  const username = await store.get(DEFAULT_SERVER_USERNAME_KEY).catch(() => null)
  const password = await store.get(DEFAULT_SERVER_PASSWORD_KEY).catch(() => null)
  return {
    url,
    displayName: typeof displayName === "string" ? displayName : undefined,
    username: typeof username === "string" ? username : undefined,
    password: typeof password === "string" ? password : undefined,
  }
}

const setDefaultServerConfig = async (config: ServerConfig | null) => {
  const store = await settingsStore
  if (config) {
    await store.set(DEFAULT_SERVER_URL_KEY, config.url).catch(() => undefined)
    if (config.displayName) await store.set(DEFAULT_SERVER_DISPLAY_NAME_KEY, config.displayName).catch(() => undefined)
    else await store.delete(DEFAULT_SERVER_DISPLAY_NAME_KEY).catch(() => undefined)
    if (config.username) await store.set(DEFAULT_SERVER_USERNAME_KEY, config.username).catch(() => undefined)
    else await store.delete(DEFAULT_SERVER_USERNAME_KEY).catch(() => undefined)
    if (config.password) await store.set(DEFAULT_SERVER_PASSWORD_KEY, config.password).catch(() => undefined)
    else await store.delete(DEFAULT_SERVER_PASSWORD_KEY).catch(() => undefined)
  } else {
    await store.delete(DEFAULT_SERVER_URL_KEY).catch(() => undefined)
    await store.delete(DEFAULT_SERVER_DISPLAY_NAME_KEY).catch(() => undefined)
    await store.delete(DEFAULT_SERVER_USERNAME_KEY).catch(() => undefined)
    await store.delete(DEFAULT_SERVER_PASSWORD_KEY).catch(() => undefined)
  }
  await store.save().catch(() => undefined)
}

const getDefaultServerUrl = async () => {
  const config = await getDefaultServerConfig()
  return config?.url ? ServerConnection.Key.make(config.url) : null
}

const setDefaultServerUrl = async (url: ServerConnection.Key | null) => {
  if (url) {
    await setDefaultServerConfig({ url })
  } else {
    await setDefaultServerConfig(null)
  }
}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element not found")
}

const App = () => {
  const [voice, setVoice] = createSignal<VoiceStatus>({ state: "prewarming", ready: false })

  const emitTranscription = (text: string, isFinal?: boolean) => {
    if (!text) return
    window.dispatchEvent(new CustomEvent("opencode:transcription", { detail: { text, isFinal } }))
  }

  const emitResume = () => {
    window.dispatchEvent(new Event("opencode:resume"))
  }

  const showVoiceError = (message?: string) => {
    if (!message) return
    showToast({
      title: "Voice input failed",
      description: message,
      variant: "error",
    })
  }

  const normalizeStatus = (value: unknown): VoiceStatus | null => {
    if (!value || typeof value !== "object") return null
    const state = (value as { state?: unknown }).state
    if (
      state !== "prewarming" &&
      state !== "ready" &&
      state !== "recording" &&
      state !== "processing" &&
      state !== "error"
    ) {
      return null
    }
    return {
      state,
      ready: (value as { ready?: unknown }).ready === true,
      message:
        typeof (value as { message?: unknown }).message === "string"
          ? (value as { message: string }).message
          : undefined,
    }
  }

  const refreshVoice = async () => {
    const result = await bridge.sendAsync<VoiceStatus>("isWhisperReady")
    const status = normalizeStatus(result)
    if (!status) return
    setVoice(status)
  }

  const startVoiceInput = async (): Promise<VoiceStartResult> => {
    await requestPermissions("mobile-bridge").catch(() => undefined)
    const result = await bridge.sendAsync<VoiceStartResult>("startRecording")
    if (result?.ok) {
      setVoice({ state: "recording", ready: false })
      return result
    }
    const message = result?.message ?? "Voice input is unavailable."
    showVoiceError(message)
    await refreshVoice()
    return {
      ok: false,
      code: result?.code ?? "voice_start_failed",
      message,
    }
  }

  const stopVoiceInput = async (): Promise<VoiceStopResult> => {
    setVoice((value) => (value.state === "recording" ? { ...value, state: "processing", ready: false } : value))
    const result = await bridge.sendAsync<VoiceStopResult>("stopRecording")
    if (!result) {
      const message = "Voice input is unavailable."
      showVoiceError(message)
      await refreshVoice()
      return {
        text: "",
        code: "voice_stop_failed",
        message,
      }
    }
    if (result.code) {
      showVoiceError(result.message ?? "Voice transcription failed.")
      await refreshVoice()
      return result
    }
    await refreshVoice()
    if (result.text) emitTranscription(result.text, true)
    return result
  }

  const platform: Platform = {
    platform: "android",
    os: "android",
    version: pkg.version,
    openLink: (url: string) => {
      void openUrl(url).catch(() => undefined)
    },
    notify: async (title: string, description?: string, href?: string, opts?: unknown) => {
      void href
      void opts
      const granted = await isPermissionGranted().catch(() => false)
      const permission = granted ? "granted" : await requestPermission().catch(() => "denied")
      if (permission !== "granted") return
      await Promise.resolve()
        .then(() =>
          sendNotification({
            title,
            body: description ?? "",
          }),
        )
        .catch(() => undefined)
    },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    restart: async () => window.location.reload(),
    voiceStatus: voice,
    startVoiceInput,
    stopVoiceInput,
    haptic: (style: "light" | "medium" | "heavy" | "success" | "warning" | "error") => {
      if (style === "success" || style === "warning" || style === "error") {
        void notificationFeedback(style).catch(() => undefined)
        return
      }
      void impactFeedback(style).catch(() => undefined)
    },
    share: async (data: { text?: string; url?: string }) => {
      const result = await bridge.sendAsync<boolean>("share", data)
      return result ?? false
    },
    getDefaultServer: getDefaultServerUrl,
    setDefaultServer: setDefaultServerUrl,
    storage: (name?: string) => createTauriStorage(name),
  }

  const [defaultConfig] = createResource(async () => {
    const config = await getDefaultServerConfig()
    return config ?? null
  })

  const [completedConfig, setCompletedConfig] = createSignal<ServerConfig | null>(null)

  const handleOnboardingComplete = async (server: {
    url: string
    displayName?: string
    username?: string
    password?: string
  }) => {
    const normalized = normalizeServerUrl(server.url)
    if (!normalized) return
    const config: ServerConfig = {
      url: normalized,
      displayName: server.displayName,
      username: server.username,
      password: server.password,
    }
    await setDefaultServerConfig(config)
    setCompletedConfig(config)
  }

  onMount(() => {
    document.documentElement.dataset.platform = "android"
    void refreshVoice()

    const syncViewport = () => {
      const height = window.visualViewport?.height ?? window.innerHeight
      document.documentElement.style.setProperty("--android-viewport-height", `${height}px`)
    }
    syncViewport()

    const handleClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement | null)?.closest("a.external-link") as HTMLAnchorElement | null
      if (!link?.href) return
      event.preventDefault()
      platform.openLink(link.href)
    }

    const onFocus = () => emitResume()
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      emitResume()
    }

    const stopListening = bridge.on("transcription", (payload) => {
      if (!payload || typeof payload !== "object") return
      const detail = payload as { text?: string; isFinal?: boolean }
      if (typeof detail.text !== "string") return
      emitTranscription(detail.text, detail.isFinal)
    })

    const stopVoiceState = bridge.on("voiceState", (payload) => {
      const status = normalizeStatus(payload)
      if (!status) return
      setVoice(status)
      if (status.state === "error") showVoiceError(status.message)
    })

    document.addEventListener("click", handleClick)
    window.addEventListener("focus", onFocus)
    window.addEventListener("resize", syncViewport)
    window.visualViewport?.addEventListener("resize", syncViewport)
    window.visualViewport?.addEventListener("scroll", syncViewport)
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("resize", syncViewport)
      window.visualViewport?.removeEventListener("resize", syncViewport)
      window.visualViewport?.removeEventListener("scroll", syncViewport)
      document.removeEventListener("visibilitychange", onVisible)
      stopListening()
      stopVoiceState()
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <VoiceInputOverlay
          state={() => {
            const state = voice().state
            if (state === "recording" || state === "processing") return state
            return "hidden"
          }}
          onStop={() => void stopVoiceInput()}
        />
        <Show when={!defaultConfig.loading}>
          <Show
            when={defaultConfig() || completedConfig()}
            fallback={<Onboarding onComplete={handleOnboardingComplete} />}
          >
            <AppInterface
              {...(() => {
                const config = (defaultConfig() || completedConfig())!
                const conn: ServerConnection.Http = {
                  type: "http",
                  displayName: config.displayName,
                  http: {
                    url: config.url,
                    username: config.username,
                    password: config.password,
                  },
                }
                return { defaultServer: ServerConnection.key(conn), servers: [conn] }
              })()}
            />
          </Show>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

if (root instanceof HTMLElement) {
  render(() => <App />, root)
}

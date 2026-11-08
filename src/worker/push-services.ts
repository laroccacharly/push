// Where a subscription may point: a push service, so the page cannot make the Worker send requests anywhere else.

const knownHosts: ReadonlyArray<RegExp> = [/^web\.push\.apple\.com$/u, /^fcm\.googleapis\.com$/u, /^updates\.push\.services\.mozilla\.com$/u, /\.notify\.windows\.com$/u]

const isKnownHost = (url: URL) => url.protocol === "https:" && knownHosts.some((host) => host.test(url.hostname))

// `extraOrigins`: a fake push service, in the tests.
export const isPushService = (endpoint: string, extraOrigins: ReadonlyArray<string>) => {
  if (!URL.canParse(endpoint)) {
    return false
  }
  const url = new URL(endpoint)
  return extraOrigins.includes(url.origin) || isKnownHost(url)
}

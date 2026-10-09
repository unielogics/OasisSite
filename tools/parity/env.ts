// Imported first (for its side effect) by every entry point that loads Playwright: on Amazon Linux 2023 aarch64
// Playwright must be told to use the ubuntu24.04-arm64 Chromium build, and it reads the variable at import time.
if (
  !process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE &&
  process.platform === 'linux' &&
  process.arch === 'arm64'
) {
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = 'ubuntu24.04-arm64'
}
export {}

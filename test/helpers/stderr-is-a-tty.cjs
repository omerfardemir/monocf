// Preloaded with NODE_OPTIONS, so that a test's monocf takes its piped stderr for a terminal, as it would under a pty.
process.stderr.isTTY = true
process.stderr.getWindowSize = () => [80, 24]

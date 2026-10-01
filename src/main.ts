process.stderr.write(
  "Densemble is not configured. This preproduction scaffold cannot start a service: " +
    "the Copilot SDK integration gate and application wiring are not implemented.\n",
);
process.exitCode = 1;

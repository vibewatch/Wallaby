import { ProductionConfigurationError, validateProductionEnvironment } from "../lib/production-config";

try {
  const { warnings } = validateProductionEnvironment();
  for (const warning of warnings) {
    console.warn(JSON.stringify({ level: "warn", event: "configuration.warning", message: warning }));
  }
} catch (error) {
  if (!(error instanceof ProductionConfigurationError)) throw error;
  console.error(JSON.stringify({
    level: "error",
    event: "configuration.invalid",
    message: "Invalid production configuration",
    issues: error.issues,
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
}

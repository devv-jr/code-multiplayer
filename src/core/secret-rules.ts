// Qué nombres de archivo se consideran "secretos". Solo reglas, sin nada de
// Node: lo usan la CLI (para frenar la subida) y el panel (para explicar
// cómo arreglarlo).
//
// Límite importante: solo se miran NOMBRES. No se lee el contenido, así que
// una clave pegada dentro de "notas.txt" no se detecta.

interface SecretRule {
  /** La línea que hay que agregar a .gitignore para este tipo de archivo. */
  ignoreLine: (baseName: string) => string;
  /** Recibe el nombre del archivo en minúsculas (sin carpetas). */
  matches: (lowerName: string) => boolean;
}

const exact = (...names: string[]): SecretRule => ({
  ignoreLine: (baseName) => baseName,
  matches: (name) => names.includes(name),
});

const extension = (...extensions: string[]): SecretRule[] =>
  extensions.map((ext) => ({
    ignoreLine: () => `*${ext}`,
    matches: (name) => name.endsWith(ext) && name.length > ext.length,
  }));

/** Plantillas de .env que sí se pueden compartir: no llevan claves reales. */
const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

/**
 * LA LISTA. Para detectar otro tipo de archivo, agrega una regla aquí.
 * Todo se compara en minúsculas: Windows y macOS no distinguen mayúsculas.
 */
const RULES: SecretRule[] = [
  // Variables de entorno: .env y .env.local, .env.production...
  exact(".env"),
  {
    ignoreLine: (baseName) => baseName,
    matches: (name) => name.startsWith(".env.") && !ENV_EXAMPLES.includes(name),
  },
  // Llaves y certificados.
  ...extension(".pem", ".key", ".p12", ".pfx", ".keystore"),
  exact("id_rsa", "id_ed25519"),
  // Credenciales de servicios.
  exact("credentials.json"),
  { ignoreLine: () => "secrets.*", matches: (name) => name.startsWith("secrets.") },
  {
    ignoreLine: () => "service-account*.json",
    matches: (name) => name.startsWith("service-account") && name.endsWith(".json"),
  },
  // Configuración de herramientas que suele guardar tokens.
  exact(".npmrc", ".pypirc", ".netrc"),
];

/** Carpetas cuyo contenido completo se considera sensible. */
const SECRET_DIRS = [".aws", ".ssh"];

/**
 * Si la ruta parece un secreto, devuelve la línea de .gitignore que la
 * taparía; si no, null. La ruta viene con "/" (como la entrega git).
 */
export function secretIgnoreLine(filePath: string): string | null {
  const parts = filePath.split("/");
  const baseName = parts[parts.length - 1] ?? "";

  const dir = parts.slice(0, -1).find((part) => SECRET_DIRS.includes(part.toLowerCase()));
  if (dir) return `${dir}/`;

  const rule = RULES.find((r) => r.matches(baseName.toLowerCase()));
  return rule ? rule.ignoreLine(baseName) : null;
}

export function isSecretPath(filePath: string): boolean {
  return secretIgnoreLine(filePath) !== null;
}

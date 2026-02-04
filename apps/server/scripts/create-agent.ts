const args = process.argv.slice(2);

const getArg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  return args[index + 1] ?? null;
};

const name = getArg("name");
const key = getArg("key");
const id = getArg("id") ?? crypto.randomUUID();

if (!name || !key) {
  console.error("Usage: bun run agent:create --name <name> --key <key> [--id <id>]");
  process.exit(1);
}

const trimmedName = name.trim();
const trimmedId = id.trim();

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!namePattern.test(trimmedName)) {
  console.error("Agent name must be 1-64 characters: letters, numbers, _ or - only.");
  process.exit(1);
}

if (!uuidPattern.test(trimmedId)) {
  console.error("Agent id must be a valid UUID.");
  process.exit(1);
}

const pepper = process.env.API_KEY_PEPPER;
if (!pepper) {
  console.error("API_KEY_PEPPER is required in the environment.");
  process.exit(1);
}

const sha256Hex = async (input: string) => {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const escapeSql = (value: string) => value.replace(/'/g, "''");

const hash = await sha256Hex(`${pepper}${key}`);
const sql = `INSERT INTO agents (id, name, api_key_hash) VALUES ('${escapeSql(trimmedId)}', '${escapeSql(trimmedName)}', '${hash}');`;

console.log(sql);

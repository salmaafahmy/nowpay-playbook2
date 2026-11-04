// Entry point of the `kb-editor` Edge Function. All logic lives in handler.ts (importable by tests).
import { handler } from "./handler.ts";

Deno.serve(handler);

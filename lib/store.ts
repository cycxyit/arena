import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ArenaState, AssetClass, AgentKind, LlmProvider } from "@/lib/types";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "arena_store.py");

export type SeatInput = {
  id?: string;
  name: string;
  provider: LlmProvider;
  model: string;
  prompt?: string;
  kind?: AgentKind;
  style?: string;
  risk?: "low" | "medium" | "high";
  color?: string;
  watchlist?: string[];
};

export type ProductResult = { symbol: string; name: string; assetClass: AssetClass; type: string; region: string; currency: string };

type TursoStore = typeof import("@/lib/store-turso");

function useTurso() {
  return Boolean(process.env.TURSO_DATABASE_URL);
}

async function turso(): Promise<TursoStore> {
  if (!useTurso()) {
    throw new Error("TURSO_DATABASE_URL is required to load the Turso store.");
  }
  return import("@/lib/store-turso");
}

function assertLocalPythonAllowed() {
  if (process.env.VERCEL) {
    throw new Error("TURSO_DATABASE_URL is required on Vercel. This deployment path is fully TypeScript/Turso and does not run Python.");
  }
}

export async function getArenaState() {
  if (useTurso()) return (await turso()).getTursoArenaState();
  return runStore<ArenaState>(["state"]);
}

export async function addSymbol(symbol: string, name: string, assetClass: AssetClass) {
  if (useTurso()) return (await turso()).addTursoSymbol(symbol, name, assetClass);
  return runStore<{ symbol: string }>(["add-symbol", symbol, name, assetClass]);
}

export async function deleteSymbol(symbol: string) {
  if (useTurso()) return (await turso()).deleteTursoSymbol(symbol);
  return runStore<{ symbol: string }>(["delete-symbol", symbol]);
}

export async function addSeat(input: SeatInput) {
  if (useTurso()) return (await turso()).addTursoSeat(input);
  return runStore<{ id: string }>(["add-seat", JSON.stringify(input)]);
}

export async function deleteSeat(id: string) {
  if (useTurso()) return (await turso()).deleteTursoSeat(id);
  return runStore<{ id: string }>(["delete-seat", id]);
}

export async function searchProducts(query: string) {
  if (useTurso()) return (await turso()).searchTursoProducts(query);
  return runStore<{ results: ProductResult[] }>(["search-products", query]);
}

export async function listModels(provider: LlmProvider) {
  if (useTurso()) return (await turso()).listTursoModels(provider);
  return runStore<{ models: string[]; error?: string }>(["list-models", provider]);
}

export async function runArenaCycle() {
  if (useTurso()) return (await turso()).runTursoArenaCycle();
  return runStore<{ synced: string[]; updated?: string[]; backfilled?: string[]; analyzed?: boolean; failed: string[]; errors: string[]; state: ArenaState }>(["run"]);
}

export async function resetArenaCompetition() {
  if (useTurso()) return (await turso()).resetTursoCompetition();
  return runStore<{ reset: boolean; state: ArenaState }>(["reset"]);
}

async function runStore<T>(args: string[]) {
  assertLocalPythonAllowed();
  const { stdout } = await execFileAsync("python", [scriptPath, ...args], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 8
  });
  return JSON.parse(stdout) as T;
}

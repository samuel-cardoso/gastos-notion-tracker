import { Client as NotionClient } from "@notionhq/client";
import { PluggyClient } from "pluggy-sdk";
import { fetchRecentTransactions, parseTrackedItems } from "./pluggy";
import { createExpensePage, getDataSourceId, transactionAlreadyRegistered } from "./notion";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

const BRAZIL_UTC_OFFSET_HOURS = 3;

/**
 * A Lambda roda em UTC, mas as transacoes sao datadas no horario do Brasil
 * (UTC-3, sem horario de verao). Perto da meia-noite UTC, "hoje" em UTC ja
 * seria amanha no Brasil, excluindo gastos do dia atual do usuario. Por
 * isso calculamos "hoje" deslocando pro horario do Brasil antes de aplicar
 * o lookback.
 */
function dateNDaysAgo(days: number): string {
  const brazilNow = new Date(Date.now() - BRAZIL_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  brazilNow.setUTCDate(brazilNow.getUTCDate() - days);
  return brazilNow.toISOString().slice(0, 10);
}

export async function handler(): Promise<{ created: number; skipped: number; total: number }> {
  const pluggyClient = new PluggyClient({
    clientId: requireEnv("PLUGGY_CLIENT_ID"),
    clientSecret: requireEnv("PLUGGY_CLIENT_SECRET"),
  });
  const notion = new NotionClient({ auth: requireEnv("NOTION_TOKEN") });

  const trackedItems = parseTrackedItems(requireEnv("PLUGGY_ITEMS"));
  const databaseId = requireEnv("NOTION_DATABASE_ID");
  const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? "7");
  const dateFrom = dateNDaysAgo(lookbackDays);

  console.log(`Buscando transacoes desde ${dateFrom} para ${trackedItems.length} item(ns)`);
  const entries = await fetchRecentTransactions(pluggyClient, trackedItems, dateFrom);
  console.log(`${entries.length} compra(s)/movimentacao(oes) encontrada(s) na Pluggy (ja agrupadas por compra)`);

  if (process.env.DRY_RUN === "true") {
    console.log("[DRY_RUN] Pulando escrita no Notion.");
    return { created: 0, skipped: 0, total: entries.length };
  }

  const dataSourceId = await getDataSourceId(notion, databaseId);

  let created = 0;
  let skipped = 0;

  for (const entry of entries) {
    try {
      const alreadyExists = await transactionAlreadyRegistered(notion, dataSourceId, entry.key);
      if (alreadyExists) {
        skipped += 1;
        continue;
      }

      await createExpensePage(notion, dataSourceId, entry);
      created += 1;
    } catch (error) {
      console.error(`Falha ao processar entrada ${entry.key}:`, error);
    }
  }

  console.log(`Concluido: ${created} criada(s), ${skipped} ja existente(s)`);
  return { created, skipped, total: entries.length };
}

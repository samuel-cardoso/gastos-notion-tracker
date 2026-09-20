import { Client } from "@notionhq/client";
import { ExpenseEntry } from "./pluggy";

const KEY_PROPERTY = "Pluggy Transaction ID";

let cachedDataSourceId: string | undefined;

/**
 * Databases da API do Notion (versao 2025-09-03+) sao um container que pode
 * ter varios "data sources" - paginas/queries agora apontam pro data source,
 * nao mais direto pro database. Bancos simples tem exatamente um data source.
 */
export async function getDataSourceId(notion: Client, databaseId: string): Promise<string> {
  if (cachedDataSourceId) {
    return cachedDataSourceId;
  }

  const database = await notion.databases.retrieve({ database_id: databaseId });
  const dataSourceId = (database as any).data_sources?.[0]?.id;

  if (!dataSourceId) {
    throw new Error(`Nao foi possivel encontrar um data source para o database ${databaseId}`);
  }

  cachedDataSourceId = dataSourceId;
  return dataSourceId;
}

export async function transactionAlreadyRegistered(
  notion: Client,
  dataSourceId: string,
  key: string
): Promise<boolean> {
  const result = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      property: KEY_PROPERTY,
      rich_text: { equals: key },
    },
    page_size: 1,
  });

  return result.results.length > 0;
}

export async function createExpensePage(
  notion: Client,
  dataSourceId: string,
  entry: ExpenseEntry
): Promise<void> {
  const dateProperty =
    entry.dateStart === entry.dateEnd
      ? { start: entry.dateStart }
      : { start: entry.dateStart, end: entry.dateEnd };

  await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      Atividades: {
        title: [{ text: { content: entry.description || "Transacao sem descricao" } }],
      },
      "Valor de parcela": { number: entry.installmentAmount },
      "Data de pagamento": { date: dateProperty },
      Pago: { checkbox: true },
      "Forma de pagamento": {
        rich_text: [{ text: { content: entry.paymentMethod } }],
      },
      "Pagar para": { select: { name: entry.bank } },
      ...(entry.cardLabel ? { Cartão: { select: { name: entry.cardLabel } } } : {}),
      ...(entry.category
        ? { Categoria: { multi_select: [{ name: entry.category }] } }
        : {}),
      [KEY_PROPERTY]: {
        rich_text: [{ text: { content: entry.key } }],
      },
    },
  });
}

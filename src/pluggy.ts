import { PluggyClient, Transaction } from "pluggy-sdk";

export interface TrackedItem {
  itemId: string;
  bank: string;
  cardLabel?: string;
}

export interface ExpenseEntry {
  /** Chave de deduplicacao: guardada no Notion pra nao duplicar entre execucoes. */
  key: string;
  description: string;
  installmentAmount: number;
  category?: string;
  bank: string;
  cardLabel?: string;
  paymentMethod: string;
  dateStart: string;
  dateEnd: string;
}

/**
 * "itemId:Banco:Cartao,itemId:Banco:Cartao" -> lista de items rastreados.
 * "Cartao" e opcional (ex: CPF/CNPJ, pra distinguir contas PF/PJ do mesmo banco).
 * O item ID de cada conta conectada vem do dashboard do Meu Pluggy.
 */
export function parseTrackedItems(raw: string): TrackedItem[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [itemId, bank, cardLabel] = entry.split(":").map((part) => part.trim());
      if (!itemId || !bank) {
        throw new Error(`Entrada invalida em PLUGGY_ITEMS: "${entry}". Use o formato itemId:Banco[:Cartao].`);
      }
      return { itemId, bank, cardLabel: cardLabel || undefined };
    });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parcelas de uma mesma compra parcelada vem como transacoes separadas na
 * Pluggy (uma por parcela, passadas e futuras). Agrupamos pela compra
 * original pra virar 1 linha so no Notion, igual ao uso manual do usuario.
 * Compras nao parceladas (ou movimentacoes de conta corrente) ficam sozinhas.
 */
function groupKey(accountId: string, transaction: Transaction): string {
  const meta = transaction.creditCardMetadata;
  if (meta && meta.totalInstallments && meta.totalInstallments > 1) {
    const purchaseDate = meta.purchaseDate ? new Date(meta.purchaseDate).toISOString() : "";
    return `${accountId}|${transaction.description}|${purchaseDate}|${meta.totalAmount ?? ""}|${meta.totalInstallments}`;
  }
  return `${accountId}|${transaction.id}`;
}

export async function fetchRecentTransactions(
  client: PluggyClient,
  items: TrackedItem[],
  dateFrom: string
): Promise<ExpenseEntry[]> {
  const groups = new Map<string, { transactions: Transaction[]; bank: string; cardLabel?: string }>();

  for (const item of items) {
    const accounts = await client.fetchAccounts(item.itemId);

    for (const account of accounts.results) {
      const page = await client.fetchAllTransactions(account.id, { dateFrom });

      for (const transaction of page) {
        // So gastos: dinheiro saindo (DEBIT). Ignora dinheiro entrando
        // (CREDIT) como Pix recebido, salario, reembolso etc.
        if (transaction.type !== "DEBIT") {
          continue;
        }

        const key = groupKey(account.id, transaction);
        const existing = groups.get(key);
        if (existing) {
          existing.transactions.push(transaction);
        } else {
          groups.set(key, { transactions: [transaction], bank: item.bank, cardLabel: item.cardLabel });
        }
      }
    }
  }

  const entries: ExpenseEntry[] = [];

  for (const [key, group] of groups) {
    const { transactions, bank, cardLabel } = group;
    const sample = transactions[0];
    const totalInstallments = sample.creditCardMetadata?.totalInstallments;

    if (totalInstallments && totalInstallments > 1) {
      // So registra compra parcelada se a 1a parcela estiver na janela
      // buscada - senao e um parcelamento antigo que so aparece de novo
      // porque ainda tem parcela futura, nao uma compra nova.
      const hasFirstInstallment = transactions.some(
        (t) => t.creditCardMetadata?.installmentNumber === 1
      );
      if (!hasFirstInstallment) {
        continue;
      }
    }

    const dates = transactions.map((t) => t.date.getTime());
    const dateStart = toIsoDate(new Date(Math.min(...dates)));
    const dateEnd = toIsoDate(new Date(Math.max(...dates)));

    entries.push({
      key,
      description: sample.description,
      installmentAmount: sample.amount,
      category: sample.category ?? undefined,
      bank,
      cardLabel,
      paymentMethod:
        totalInstallments && totalInstallments > 1
          ? `Mensal em ${totalInstallments}x`
          : sample.paymentData?.referenceNumber ?? "Debito",
      dateStart,
      dateEnd,
    });
  }

  return entries;
}

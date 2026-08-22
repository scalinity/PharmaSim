// Money and data formatting for the HUD. Everything here is set in IBM Plex
// Mono by the stylesheet (§28) — cents show only when a value has them, so
// whole-dollar ledgers stay quiet and discounted unit prices stay honest.

const MINUS = "\u2212";

export function money(n: number): string {
  const abs = Math.abs(n);
  const digits = Math.abs(abs - Math.round(abs)) < 0.005 ? 0 : 2;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n < 0 ? MINUS : ""}$${body}`;
}

/** Ledger style: the sign is always printed. */
export function signedMoney(n: number): string {
  return n < 0 ? money(n) : `+${money(n)}`;
}

export function signed(n: number, digits: number): string {
  return `${n < 0 ? MINUS : "+"}${Math.abs(n).toFixed(digits)}`;
}

/** Price slider position said out loud: 1.0 is the printed MSRP. */
export function multiplierLabel(multiplier: number): string {
  return Math.abs(multiplier - 1) < 0.001 ? "MSRP" : `\u00d7${multiplier.toFixed(2)}`;
}

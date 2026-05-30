export interface WalletMethod {
  value: string;
  label: string;
  /** Address validation for this crypto network. */
  validate: RegExp;
}

export const WALLET_CONFIG = {
  minWithdrawalUsd: 50,
  methods: [
    { value: "USDT_TRC20", label: "USDT (TRC20)", validate: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
    { value: "USDT_ERC20", label: "USDT (ERC20)", validate: /^0x[a-fA-F0-9]{40}$/ },
    { value: "BTC",        label: "Bitcoin",      validate: /^(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
    { value: "ETH",        label: "Ethereum",     validate: /^0x[a-fA-F0-9]{40}$/ },
    { value: "USDC",       label: "USDC (ERC20)", validate: /^0x[a-fA-F0-9]{40}$/ },
  ] as WalletMethod[],
} as const;

export function findWalletMethod(value: string): WalletMethod | undefined {
  return WALLET_CONFIG.methods.find((m) => m.value === value);
}

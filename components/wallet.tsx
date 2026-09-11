"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Address } from "viem";
import { balanceEth, connect as connectWallet, currentChainId, discoverProvider, ensureChain, getProvider, hasWallet, walletErrorMessage, CHAIN_ID } from "@/lib/browser";
import { short } from "./ui";

interface WalletState {
  address: Address | null;
  chainId: number | null;
  balance: number | null;
  wrongChain: boolean;
  available: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside <WalletProvider>");
  return v;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  const refresh = useCallback(async () => {
    setChainId(await currentChainId());
    if (address) {
      try {
        setBalance(await balanceEth(address));
      } catch {
        setBalance(null);
      }
    }
  }, [address]);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      await ensureChain();
    } catch (e) {
      setError(walletErrorMessage(e));
    }
    setChainId(await currentChainId());
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const a = await connectWallet();
      setAddress(a);
      setChainId(await currentChainId());
    } catch (e) {
      setError(walletErrorMessage(e));
      setConnecting(false);
      return;
    }
    setConnecting(false);
    // Best effort: nudge the wallet onto the right chain. If the user declines
    // they stay connected and get the explicit "switch network" control.
    await switchChain();
  }, [switchChain]);

  // Find the wallet (even one that injects late or only via EIP-6963) and
  // discover an already-authorized account without prompting.
  useEffect(() => {
    let wired: any = null;
    const onAccounts = (a: unknown) => setAddress(((a as string[])?.[0] as Address) ?? null);
    const onChain = (id: unknown) => setChainId(parseInt(id as string, 16));
    const wire = (provider: any) => {
      if (wired) return;
      wired = provider;
      setAvailable(true);
      (async () => {
        try {
          const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
          if (accounts?.[0]) setAddress(accounts[0] as Address);
        } catch {}
        setChainId(await currentChainId());
      })();
      provider.on?.("accountsChanged", onAccounts);
      provider.on?.("chainChanged", onChain);
    };
    setAvailable(hasWallet());
    const existing = getProvider();
    if (existing) wire(existing);
    const stop = discoverProvider(wire);
    return () => {
      stop();
      wired?.removeListener?.("accountsChanged", onAccounts);
      wired?.removeListener?.("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const wrongChain = address != null && chainId != null && chainId !== CHAIN_ID;

  return (
    <Ctx.Provider value={{ address, chainId, balance, wrongChain, available, connecting, error, connect, switchChain, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

/** The compact connect control shown in the header. */
export function WalletButton() {
  const w = useWallet();
  if (!w.available) {
    return (
      <a href="https://ethereum.org/en/wallets/find-wallet/" target="_blank" rel="noreferrer" title="You need a browser wallet to trade">
        <span className="inline-flex items-center gap-2 mono text-[10.5px] tracking-[0.08em] uppercase px-2.5 py-[6px] rounded border border-line2 text-faint hover:text-txt">
          No wallet ↗
        </span>
      </a>
    );
  }
  if (!w.address) {
    return (
      <button onClick={w.connect} disabled={w.connecting} title={w.error ?? undefined} className="inline-flex items-center gap-2 mono text-[10.5px] tracking-[0.08em] uppercase px-3 py-[6px] rounded border border-red/50 text-red-bright hover:bg-red/10 transition-colors disabled:opacity-50">
        {w.connecting ? "connecting…" : w.error ? "Retry connect" : "Connect wallet"}
      </button>
    );
  }
  if (w.wrongChain) {
    return (
      <button onClick={w.switchChain} className="inline-flex items-center gap-2 mono text-[10.5px] tracking-[0.08em] uppercase px-3 py-[6px] rounded border border-amber-400/50 text-amber-300 hover:bg-amber-400/10 transition-colors">
        Switch to Base Sepolia
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 mono text-[10.5px] tracking-[0.08em] uppercase px-3 py-[6px] rounded border border-emerald-400/35 text-emerald-300" title={w.address}>
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
      {short(w.address)}
      {w.balance != null && <span className="text-faint normal-case tracking-normal">· {w.balance.toFixed(4)} ETH</span>}
    </span>
  );
}


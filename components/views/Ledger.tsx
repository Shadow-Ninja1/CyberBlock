"use client";

import { useEffect, useRef, useState } from "react";
import type { LogLine } from "@/lib/types";
import { ROLE } from "../ui";

export default function Ledger({ logs, explorer }: { logs: LogLine[]; explorer?: string }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs, open]);
  const last = logs[logs.length - 1];
  const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className={`fixed left-0 md:left-[72px] right-0 bottom-0 z-30 bg-[#070709] border-t border-line mono text-[12px] transition-[height] ${open ? "h-[300px]" : "h-11"}`}>
      <button onClick={() => setOpen(!open)} className="w-full h-11 px-4 sm:px-6 lg:px-10 flex items-center gap-3 sm:gap-6 text-left">
        <span className="text-red-bright flex items-center gap-2 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-red-bright live-dot" /> ledger
        </span>
        {!open && (
          <span className="text-dim truncate flex-1 min-w-0">
            {last ? (
              <>
                <span className="text-faint">{t(last.at)}</span> <span style={{ color: ROLE[last.actor]?.color }}>{ROLE[last.actor]?.label.toLowerCase()}</span> {last.message}
              </>
            ) : (
              <span className="text-faint">awaiting first transaction</span>
            )}
          </span>
        )}
        <span className="ml-auto shrink-0 text-faint whitespace-nowrap">{logs.length} lines · {open ? "collapse ▾" : "expand ▴"}</span>
      </button>
      {open && (
        <div ref={boxRef} className="h-[calc(300px-44px)] overflow-y-auto px-6 lg:px-10 pb-4 flex flex-col gap-1.5">
          {logs.length === 0 && <div className="text-faint py-6">Every line here is a real signed transaction. Nothing yet.</div>}
          {logs.map((l, i) => (
            <div key={i} className="grid grid-cols-[76px_90px_1fr] gap-3 rise">
              <span className="text-faint">{t(l.at)}</span>
              <span className="truncate" style={{ color: ROLE[l.actor]?.color ?? "#63636E" }}>{ROLE[l.actor]?.label.toLowerCase() ?? l.actor}</span>
              <span className={l.level === "error" ? "text-red-bright" : l.level === "warn" ? "text-amber-300" : "text-dim"}>
                {l.message}
                {l.txHash && explorer && (
                  <a className="text-red-bright hover:text-txt ml-2" href={`${explorer}/tx/${l.txHash}`} target="_blank" rel="noreferrer">tx ↗</a>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

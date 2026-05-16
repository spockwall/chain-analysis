/**
 * NicknamesContext — per-user address nicknames.
 *
 * Loads nicknames from the backend once on login and exposes a lookup helper
 * plus mutators. Display order across the UI is: entity.name (global label) ->
 * user nickname -> truncated address.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { deleteNickname as apiDelete, listNicknames, upsertNickname as apiUpsert } from "../api/client";
import { useAuth } from "./AuthContext";

interface NicknamesContextValue {
    nicknames: Map<string, string>;
    getNickname: (address: string) => string | undefined;
    setNickname: (address: string, nickname: string) => Promise<void>;
    removeNickname: (address: string) => Promise<void>;
}

const NicknamesContext = createContext<NicknamesContextValue>({
    nicknames: new Map(),
    getNickname: () => undefined,
    setNickname: async () => {},
    removeNickname: async () => {},
});

export function useNicknames(): NicknamesContextValue {
    return useContext(NicknamesContext);
}

export function NicknamesProvider({ children }: { children: React.ReactNode }) {
    const { isAuthenticated } = useAuth();
    const [nicknames, setNicknames] = useState<Map<string, string>>(new Map());

    useEffect(() => {
        if (!isAuthenticated) {
            setNicknames(new Map());
            return;
        }
        let cancelled = false;
        listNicknames()
            .then((items) => {
                if (cancelled) return;
                const next = new Map<string, string>();
                for (const item of items) next.set(item.address.toLowerCase(), item.nickname);
                setNicknames(next);
            })
            .catch(() => {
                // Silent — non-critical UI affordance.
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated]);

    const getNickname = useCallback(
        (address: string) => nicknames.get(address.toLowerCase()),
        [nicknames],
    );

    const setNickname = useCallback(async (address: string, nickname: string) => {
        const saved = await apiUpsert(address, nickname);
        setNicknames((prev) => {
            const next = new Map(prev);
            next.set(saved.address.toLowerCase(), saved.nickname);
            return next;
        });
    }, []);

    const removeNickname = useCallback(async (address: string) => {
        await apiDelete(address);
        setNicknames((prev) => {
            const next = new Map(prev);
            next.delete(address.toLowerCase());
            return next;
        });
    }, []);

    const value = useMemo<NicknamesContextValue>(
        () => ({ nicknames, getNickname, setNickname, removeNickname }),
        [nicknames, getNickname, setNickname, removeNickname],
    );

    return <NicknamesContext.Provider value={value}>{children}</NicknamesContext.Provider>;
}

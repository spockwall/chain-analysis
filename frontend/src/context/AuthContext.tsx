/**
 * AuthContext — global authentication state.
 *
 * Token is persisted in an httpOnly cookie managed by the server.
 * The browser automatically includes it in all requests.
 * Provides login, register, and logout helpers to any component.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
    fetchMe,
    login as apiLogin,
    logout as apiLogout,
    register as apiRegister,
} from "../api/client";
import type { RegisterRequest, UserResponse } from "../types";

interface AuthContextValue {
    user: UserResponse | null;
    isAuthenticated: boolean;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (username: string, email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
    user: null,
    isAuthenticated: false,
    loading: true,
    login: async () => {},
    register: async () => {},
    logout: async () => {},
});

export function useAuth(): AuthContextValue {
    return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<UserResponse | null>(null);
    const [loading, setLoading] = useState(true);

    // On mount: restore session from httpOnly cookie
    useEffect(() => {
        fetchMe()
            .then((u) => setUser(u))
            .catch(() => setUser(null))  // Not authenticated or cookie expired
            .finally(() => setLoading(false));
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const res = await apiLogin({ email, password });
        setUser(res);
    }, []);

    const register = useCallback(async (username: string, email: string, password: string) => {
        const body: RegisterRequest = { username, email, password };
        const res = await apiRegister(body);
        setUser(res);
    }, []);

    const logout = useCallback(async () => {
        await apiLogout();
        setUser(null);
    }, []);

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: user !== null,
                loading,
                login,
                register,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

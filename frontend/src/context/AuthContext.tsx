/**
 * AuthContext — global authentication state.
 *
 * Persists the JWT in localStorage so the user stays logged in across reloads.
 * Provides login, register, and logout helpers to any component.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
    clearStoredToken,
    fetchMe,
    getStoredToken,
    login as apiLogin,
    register as apiRegister,
    setStoredToken,
} from "../api/client";
import type { RegisterRequest, UserResponse } from "../types";

interface AuthContextValue {
    user: UserResponse | null;
    isAuthenticated: boolean;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (username: string, email: string, password: string) => Promise<void>;
    logout: () => void;
}

export const AuthContext = createContext<AuthContextValue>({
    user: null,
    isAuthenticated: false,
    loading: true,
    login: async () => {},
    register: async () => {},
    logout: () => {},
});

export function useAuth(): AuthContextValue {
    return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<UserResponse | null>(null);
    const [loading, setLoading] = useState(true);

    // On mount: restore session from localStorage token
    useEffect(() => {
        const token = getStoredToken();
        if (!token) {
            setLoading(false);
            return;
        }
        fetchMe()
            .then((u) => setUser(u))
            .catch(() => clearStoredToken()) // token expired / invalid
            .finally(() => setLoading(false));
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const res = await apiLogin({ email, password });
        setStoredToken(res.access_token);
        setUser(res.user);
    }, []);

    const register = useCallback(async (username: string, email: string, password: string) => {
        const body: RegisterRequest = { username, email, password };
        const res = await apiRegister(body);
        setStoredToken(res.access_token);
        setUser(res.user);
    }, []);

    const logout = useCallback(() => {
        clearStoredToken();
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

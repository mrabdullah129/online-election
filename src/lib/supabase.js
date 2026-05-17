import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null;

export async function signUpWithProfile({ email, password, name, phone }) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }

  return supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name, phone, role: "voter" },
      emailRedirectTo: window.location.origin,
    },
  });
}

export async function signInWithEmail({ email, password }) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }

  return supabase.auth.signInWithPassword({ email, password });
}

export async function requestPasswordReset(email) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }

  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
}

// Sync app state to Supabase for cross-browser consistency
export async function saveAppState(userId, appData) {
  if (!supabase) {
    return { error: new Error("Supabase not configured") };
  }

  try {
    // Single-statement upsert avoids transient delete/insert gaps and duplicate writes.
    const { data, error } = await supabase
      .from("app_state")
      .upsert(
        {
          user_id: userId,
          state: appData,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select("updated_at")
      .single();

    if (error) {
      console.warn("Failed to save app state to Supabase:", error);
      return { error };
    }

    console.log("✅ App state saved to Supabase for user:", userId);
    return { data };
  } catch (err) {
    console.warn("Error saving app state:", err);
    return { error: err };
  }
}

// Load app state from Supabase for cross-browser consistency
export async function loadAppState(userId) {
  if (!supabase) {
    return { data: null, error: new Error("Supabase not configured") };
  }

  try {
    const { data, error } = await supabase
      .from("app_state")
      .select("state, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.warn("Failed to load app state from Supabase:", error);
      return { data: null, error };
    }

    if (data?.state) {
      console.log("✅ App state loaded from Supabase for user:", userId);
      return { data: data.state, updatedAt: data.updated_at || null, error: null };
    }

    console.log("No app state found in Supabase for user:", userId);
    return { data: null, error: null };
  } catch (err) {
    console.warn("Error loading app state:", err);
    return { data: null, error: err };
  }
}

// Subscribe to real-time app state changes across browsers
export function subscribeToAppState(userId, onStateChange) {
  if (!supabase) {
    return null;
  }

  const subscription = supabase
    .channel(`app-state-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "app_state",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        if (payload.new?.state) {
          onStateChange(payload.new.state, payload.new.updated_at || payload.commit_timestamp || null);
        }
      }
    )
    .subscribe();

  return subscription;
}

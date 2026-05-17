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
    // Ensure app_state table exists, then save/update data
    const { data, error } = await supabase.from("app_state").upsert(
      {
        user_id: userId,
        state: appData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) {
      console.warn("Failed to save app state to Supabase:", error);
      return { error };
    }

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
      .select("state")
      .eq("user_id", userId)
      .single();

    if (error?.code === "PGRST116") {
      // No data found - this is expected on first load
      return { data: null, error: null };
    }

    if (error) {
      console.warn("Failed to load app state from Supabase:", error);
      return { data: null, error };
    }

    return { data: data?.state || null, error: null };
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
          onStateChange(payload.new.state);
        }
      }
    )
    .subscribe();

  return subscription;
}

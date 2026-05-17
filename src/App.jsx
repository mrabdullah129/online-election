import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  FileText,
  Flag,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Mail,
  Moon,
  Plus,
  Search,
  ShieldCheck,
  Timer,
  Unlock,
  UserCheck,
  Users,
  Vote,
  XCircle,
} from "lucide-react";
import { jsPDF } from "jspdf";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { createDemoData } from "./lib/mockData.js";
import {
  buildAuditLog,
  canVote,
  formatCountdown,
  formatDateTime,
  generateSecretId,
  getElectionStatus,
  getResults,
  getTurnout,
  getVoteTotal,
  getWinner,
  isRegistrationOpen,
  maskSecretId,
  shouldAutoLock,
} from "./lib/electionEngine.js";
import {
  isSupabaseConfigured,
  loadAppState,
  requestPasswordReset,
  saveAppState,
  signInWithEmail,
  signUpWithProfile,
  supabase,
  subscribeToAppState,
} from "./lib/supabase.js";

const STORAGE_KEY = "secure-election-demo-state";
const SESSION_KEY = "secure-election-current-user";
const CHART_COLORS = ["#2563eb", "#0f766e", "#f97316", "#7c3aed", "#dc2626"];

const roleLabels = {
  super_admin: "Super Admin",
  creator: "Election Creator",
  voter: "Voter",
};

const SECRET_ID_PATTERN = /\b([A-Z0-9][A-Z0-9_-]*-\d{4}-[A-Z0-9]{4})\b/i;
const SECRET_SUBJECT_PREFIX = "Your secure voter ID for ";

function normalizeSecretId(secretId) {
  return String(secretId || "").trim().toUpperCase();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function extractIssuedSecretId(...values) {
  for (const value of values) {
    const match = String(value || "").match(SECRET_ID_PATTERN);
    if (match?.[1]) return normalizeSecretId(match[1]);
  }
  return "";
}

function getSecretNotificationTitle(notification) {
  const subject = String(notification?.subject || "").trim();
  if (subject.toLowerCase().startsWith(SECRET_SUBJECT_PREFIX.toLowerCase())) {
    return subject.slice(SECRET_SUBJECT_PREFIX.length).trim();
  }
  return "";
}

function secretLookupKey(title, email) {
  return `${String(title || "").trim().toLowerCase()}::${String(email || "").trim().toLowerCase()}`;
}

function formatStoredSecretId(prefix, ordinal, suffix) {
  if (!ordinal || !suffix) return "";
  return `${String(prefix || "POLL").trim().toUpperCase()}-${String(ordinal).padStart(4, "0")}-${String(suffix).trim().toUpperCase()}`;
}

function parseSecretId(secretId) {
  const normalized = normalizeSecretId(secretId);
  const match = normalized.match(/^([A-Z0-9][A-Z0-9_-]*)-(\d{4})-([A-Z0-9]{4})$/);
  if (!match) return null;

  return {
    prefix: match[1],
    ordinal: Number(match[2]),
    suffix: match[3],
  };
}

function buildSecretVoteCandidates(election, registration, secretId) {
  const normalized = normalizeSecretId(secretId);
  const parsed = parseSecretId(normalized);
  const prefix = parsed?.prefix || String(election?.codePrefix || "").trim().toUpperCase();
  const suffix = String(registration?.secret_code_suffix || parsed?.suffix || "").trim().toUpperCase();
  const maxOrdinal = Math.min(
    Math.max(
      Number(election?.maxVoters) || 0,
      Number(election?.finalizedVoterCount) || 0,
      election?.registrations?.length || 0,
      parsed?.ordinal || 0,
      1,
    ),
    500,
  );
  const candidates = [normalized];

  if (prefix && suffix) {
    for (let ordinal = 1; ordinal <= maxOrdinal; ordinal += 1) {
      candidates.push(formatStoredSecretId(prefix, ordinal, suffix));
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

function isMissingColumnError(error, columnName) {
  const message = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  return message.toLowerCase().includes(columnName.toLowerCase());
}

function isSecretVoteError(message) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("invalid secret id") || normalized.includes("vote already used");
}

const defaultElectionForm = {
  title: "",
  description: "",
  category: "University",
  startAt: "",
  endAt: "",
  registrationDeadline: "",
  maxVoters: 100,
};

const defaultCandidateForm = {
  name: "",
  designation: "",
  manifesto: "",
  photo: "",
};

function loadInitialData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (error) {
    console.warn("Failed to load localStorage, using demo data:", error);
  }

  if (isSupabaseConfigured && supabase) {
    return { users: [], creatorRequests: [], elections: [], auditLogs: [], notifications: [] };
  }

  return createDemoData();
}

function mapProfile(user, profile) {
  return {
    id: user.id,
    name: profile?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "Member",
    email: profile?.email || user.email || "",
    phone: profile?.phone || user.user_metadata?.phone || "",
    role: profile?.role || "voter",
    organization: profile?.organization || user.user_metadata?.organization || "",
    verified: true,
    approved: profile?.creator_approved || profile?.role !== "creator",
  };
}

function App() {
  const [data, setData] = useState(loadInitialData);
  const [currentUserId, setCurrentUserId] = useState(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    return saved || "u-admin"; // Default to admin for demo
  });
  const [view, setView] = useState("landing");
  const [accessView, setAccessView] = useState("chooser");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [notice, setNotice] = useState("Sign in to manage elections or create a new account to get started.");
  const [noticeVisible, setNoticeVisible] = useState(() => Boolean(notice));
  const [darkMode, setDarkMode] = useState(false);
  const [now, setNow] = useState(new Date());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const currentUser = data.users.find((user) => user.id === currentUserId) || null;

  // Save app data to both localStorage and Supabase for cross-browser sync
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    // Also sync to Supabase if configured and user is logged in
    if (isSupabaseConfigured && currentUserId) {
      saveAppState(currentUserId, data).catch((error) => {
        console.warn("Failed to sync to Supabase:", error);
      });
    }
  }, [data, currentUserId]);

  useEffect(() => {
    if (currentUserId) localStorage.setItem(SESSION_KEY, currentUserId);
    else localStorage.removeItem(SESSION_KEY);
  }, [currentUserId]);

  // Load app data from Supabase for cross-browser sync and subscribe to changes
  useEffect(() => {
    if (!isSupabaseConfigured || !currentUserId) return undefined;

    let active = true;
    let subscription;

    async function loadAndSubscribe() {
      // Load latest data from Supabase
      const { data: supabaseData, error } = await loadAppState(currentUserId);

      if (!active) return;

      if (supabaseData && supabaseData.elections) {
        // Update state with data from Supabase
        setData(supabaseData);
      }

      // Subscribe to real-time changes from other tabs/browsers
      subscription = subscribeToAppState(currentUserId, (updatedState) => {
        if (active) {
          setData(updatedState);
        }
      });
    }

    loadAndSubscribe();

    return () => {
      active = false;
      if (subscription) {
        subscription.unsubscribe();
      }
    };
  }, [currentUserId]);

  // Keep React session in sync with localStorage and other tabs/scripts
  useEffect(() => {
    function onStorage(e) {
      if (e.key === SESSION_KEY) {
        setCurrentUserId(e.newValue || "");
      }
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Global error handlers to capture uncaught errors and promise rejections into audit logs
  useEffect(() => {
    function handleError(ev) {
      try {
        setData((prev) => ({
          ...prev,
          auditLogs: [
            buildAuditLog("client_error", "Client", `${ev?.message || ev?.reason || String(ev)}`),
            ...prev.auditLogs,
          ],
        }));
      } catch {
        // swallow
      }
    }

    function handleRejection(ev) {
      try {
        setData((prev) => ({
          ...prev,
          auditLogs: [
            buildAuditLog("unhandled_rejection", "Client", `${ev?.reason || String(ev)}`),
            ...prev.auditLogs,
          ],
        }));
      } catch {
        // swallow
      }
    }

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  // Auto-hide and manual dismiss for the top notice strip.
  useEffect(() => {
    if (!notice) {
      setNoticeVisible(false);
      return undefined;
    }

    // Show when a new notice appears
    setNoticeVisible(true);
    const timer = setTimeout(() => setNoticeVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

    let active = true;

    async function syncProfile(user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, full_name, email, phone, role, organization, creator_approved")
        .eq("id", user.id)
        .maybeSingle();

      if (!active) return;

      const mappedUser = mapProfile(user, profile);
      setCurrentUserId(mappedUser.id);
      setData((previous) => ({
        ...previous,
        users: previous.users.some((item) => item.id === mappedUser.id)
          ? previous.users.map((item) => (item.id === mappedUser.id ? { ...item, ...mappedUser } : item))
          : [mappedUser, ...previous.users],
      }));
    }

    supabase.auth.getSession().then(({ data: sessionData }) => {
      const user = sessionData.session?.user;
      if (!active || !user) return;

      syncProfile(user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      if (!active) return;

      if (user) {
        syncProfile(user);
      } else {
        // Preserve demo/local session when Supabase auth is not active.
        setCurrentUserId((saved) => saved || localStorage.getItem(SESSION_KEY) || "");
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // Close mobile menu when resizing to larger screens
  useEffect(() => {
    function onResize() {
      if (window.innerWidth > 900) setMobileMenuOpen(false);
    }

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // When Supabase is configured, load authoritative data from the backend
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;

    let active = true;

    async function fetchSupabaseData() {
      try {
        // Profiles -> users
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name, email, phone, role, organization, creator_approved");

        const users = (profiles || []).map((p) => ({
          id: p.id,
          name: p.full_name || p.email.split("@")[0],
          email: p.email,
          phone: p.phone || "",
          role: p.role || "voter",
          organization: p.organization || "",
          verified: true,
          approved: !!p.creator_approved,
        }));

        // Creator requests
        const { data: creatorRequests } = await supabase
          .from("creator_requests")
          .select("id, full_name, email, phone, organization, purpose, status, rejection_reason, created_at");

        // Elections and related data
        const { data: electionsRows } = await supabase.from("elections").select("id, creator_id, title, description, category, code_prefix, start_at, end_at, registration_deadline, max_voters, published, locked, finalized_voter_count, result_locked, created_at, updated_at");

        const electionIds = (electionsRows || []).map((e) => e.id);

        const { data: candidatesRows } = electionIds.length
          ? await supabase.from("candidates").select("id, election_id, name, designation, manifesto, photo_url, created_at").in("election_id", electionIds)
          : { data: [] };

        let regsRows = [];
        if (electionIds.length) {
          const registrationColumns =
            "id, election_id, voter_id, accepted_terms, status, secret_code_suffix, secret_code_ordinal, voted, voted_at, joined_at";
          const legacyRegistrationColumns =
            "id, election_id, voter_id, accepted_terms, status, secret_code_suffix, voted, voted_at, joined_at";

          let registrationsResponse = await supabase.from("voter_registrations").select(registrationColumns).in("election_id", electionIds);

          if (registrationsResponse.error && isMissingColumnError(registrationsResponse.error, "secret_code_ordinal")) {
            registrationsResponse = await supabase.from("voter_registrations").select(legacyRegistrationColumns).in("election_id", electionIds);
          }

          if (registrationsResponse.error) {
            throw registrationsResponse.error;
          }

          regsRows = registrationsResponse.data || [];
        }

        const { data: resultsRows } = electionIds.length
          ? await supabase.from("public_election_results").select("election_id,candidate_id,candidate_name,vote_count,title").in("election_id", electionIds)
          : { data: [] };

        const { data: notificationsRows, error: notificationsError } = await supabase
          .from("notifications")
          .select("id, recipient_email, type, subject, body, status, created_at")
          .eq("type", "secret_id")
          .order("created_at", { ascending: true });

        if (notificationsError) {
          console.warn("Failed to load voter secret notifications:", notificationsError);
        }

        // Helper maps
        const profilesById = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
        const candidatesByElection = {};
        (candidatesRows || []).forEach((c) => {
          if (!candidatesByElection[c.election_id]) candidatesByElection[c.election_id] = [];
          candidatesByElection[c.election_id].push({
            id: c.id,
            name: c.name,
            designation: c.designation,
            manifesto: c.manifesto,
            photo: c.photo_url || "",
            backendSynced: true,
          });
        });

        const regsByElection = {};
        (regsRows || []).forEach((r) => {
          if (!regsByElection[r.election_id]) regsByElection[r.election_id] = [];
          const profile = profilesById[r.voter_id] || {};
          regsByElection[r.election_id].push({
            id: r.id,
            voterId: r.voter_id,
            name: profile.full_name || profile.email?.split("@")[0] || "Member",
            email: profile.email || "",
            acceptedTerms: r.accepted_terms || false,
            status: r.status,
            secret_code_suffix: r.secret_code_suffix,
            secretCodeOrdinal: r.secret_code_ordinal,
            voted: r.voted || false,
            votedAt: r.voted_at,
            joinedAt: r.joined_at,
            backendSynced: true,
          });
        });

        const resultsByCandidate = {};
        (resultsRows || []).forEach((row) => {
          resultsByCandidate[row.candidate_id] = row.vote_count || 0;
        });

        const secretIdByElectionAndEmail = new Map();
        (notificationsRows || []).forEach((notification) => {
          const secretId = extractIssuedSecretId(notification.body, notification.subject);
          const electionTitle = getSecretNotificationTitle(notification);
          if (!secretId || !electionTitle || !notification.recipient_email) return;
          secretIdByElectionAndEmail.set(secretLookupKey(electionTitle, notification.recipient_email), secretId);
        });

        // Build elections in the frontend shape and reconstruct `secretId` when suffix is present
        const elections = (electionsRows || []).map((e) => {
          const candidates = (candidatesByElection[e.id] || []).map((c) => ({ ...c }));
          const regs = (regsByElection[e.id] || []).map((r) => ({ ...r }));

          regs.forEach((r) => {
            const issuedSecretId = secretIdByElectionAndEmail.get(secretLookupKey(e.title, r.email));
            r.secretId = issuedSecretId || formatStoredSecretId(e.code_prefix, r.secretCodeOrdinal, r.secret_code_suffix);
          });

          // Legacy fallback for projects that have not run the latest SQL patch yet.
          const withSuffix = regs.filter((r) => r.secret_code_suffix && !r.secretId).sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
          withSuffix.forEach((r, idx) => {
            r.secretId = `${e.code_prefix}-${String(idx + 1).padStart(4, "0")}-${r.secret_code_suffix}`;
          });

          // votes map for candidate ids -> counts
          const votes = (candidates || []).reduce((acc, cand) => ({ ...acc, [cand.id]: resultsByCandidate[cand.id] || 0 }), {});

          return {
            id: e.id,
            codePrefix: e.code_prefix,
            creatorId: e.creator_id,
            title: e.title,
            description: e.description,
            category: e.category,
            startAt: e.start_at,
            endAt: e.end_at,
            registrationDeadline: e.registration_deadline,
            maxVoters: e.max_voters,
            published: e.published,
            locked: e.locked,
            finalizedVoterCount: e.finalized_voter_count,
            resultLocked: e.result_locked,
            backendSynced: true,
            registrations: regs,
            waitlist: [],
            candidates,
            votes,
            createdAt: e.created_at,
            updatedAt: e.updated_at,
          };
        });

        if (!active) return;

        setData((prev) => {
          const backendElectionIds = new Set(elections.map((election) => election.id));
          const localElections = (prev.elections || []).filter(
            (election) =>
              election.backendSynced !== true &&
              !backendElectionIds.has(election.id) &&
              !String(election.id || "").startsWith("poll-"),
          );
          const backendUserIds = new Set(users.map((user) => user.id));
          const localUsers = (prev.users || []).filter((user) => !backendUserIds.has(user.id) && !String(user.id || "").startsWith("u-"));

          return {
            ...prev,
            users: [...users, ...localUsers],
            creatorRequests: creatorRequests || [],
            elections: [...elections, ...localElections],
            auditLogs: prev.auditLogs || [],
            notifications: notificationsRows || [],
          };
        });
      } catch (err) {
        console.error("Failed to load Supabase data:", err);
      }
    }

    fetchSupabaseData();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = new Date();
      setNow(current);
      setData((previous) => {
        let changed = false;
        const logs = [...previous.auditLogs];
        const notifications = [...previous.notifications];
        const elections = previous.elections.map((election) => {
          if (!shouldAutoLock(election, current)) return election;
          changed = true;
          const lockedElection = finalizeElectionRecord(election);
          logs.unshift(
            buildAuditLog(
              "auto_lock",
              "System",
              `${election.title} was locked after reaching a voter limit or registration deadline.`,
            ),
          );
          lockedElection.registrations.forEach((registration) => {
            if (!registration.secretId) return;
            notifications.unshift({
              id: crypto.randomUUID(),
              type: "secret_id",
              recipient: registration.email,
              subject: `Your secure voter ID for ${election.title}`,
              status: "queued",
              createdAt: new Date().toISOString(),
            });
          });
          return lockedElection;
        });

        return changed ? { ...previous, elections, auditLogs: logs, notifications } : previous;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const dashboardTarget = currentUser?.role === "super_admin" ? "admin" : currentUser?.role === "creator" ? "creator" : "voter";

  const metrics = useMemo(() => {
    const statuses = data.elections.map((election) => getElectionStatus(election, now));
    const totalVotes = data.elections.reduce((sum, election) => sum + getVoteTotal(election), 0);

    return {
      totalElections: data.elections.length,
      active: statuses.filter((status) => status === "active").length,
      upcoming: statuses.filter((status) => status === "upcoming").length,
      completed: statuses.filter((status) => status === "completed").length,
      users: data.users.length,
      votes: totalVotes,
      turnout:
        data.elections.length > 0
          ? Math.round(data.elections.reduce((sum, election) => sum + getTurnout(election), 0) / data.elections.length)
          : 0,
    };
  }, [data.elections, data.users.length, now]);

  const filteredElections = useMemo(() => {
    return data.elections
      .filter((election) => election.published || currentUser?.role === "creator" || currentUser?.role === "super_admin")
      .filter((election) => {
        const status = getElectionStatus(election, now);
        const query = search.trim().toLowerCase();
        const matchesStatus = statusFilter === "all" || status === statusFilter;
        const matchesSearch =
          !query ||
          election.title.toLowerCase().includes(query) ||
          election.category.toLowerCase().includes(query) ||
          election.description.toLowerCase().includes(query);
        return matchesStatus && matchesSearch;
      })
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  }, [currentUser?.role, data.elections, now, search, statusFilter]);

  function addLog(action, actor, detail) {
    setData((previous) => ({
      ...previous,
      auditLogs: [buildAuditLog(action, actor, detail), ...previous.auditLogs],
    }));
  }

  function handleLogout() {
    if (currentUser) addLog("logout", currentUser.name, "Session ended.");
    if (supabase) supabase.auth.signOut();
    setCurrentUserId("");
    setView("landing");
    setNotice("Signed out.");
  }

  async function handleSignup(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email")).trim().toLowerCase();
    const name = String(formData.get("name")).trim();
    const phone = String(formData.get("phone")).trim();
    const password = String(formData.get("password"));

    try {
      const { data: signUpData, error } = await signUpWithProfile({ email, password, name, phone });
      if (error) throw error;

      const authUser = signUpData.user;
      if (authUser) {
        const newUser = {
          id: authUser.id,
          name,
          email,
          phone,
          role: "voter",
          verified: true,
        };

        setData((previous) => ({
          ...previous,
          users: previous.users.some((user) => user.id === newUser.id)
            ? previous.users.map((user) => (user.id === newUser.id ? { ...user, ...newUser } : user))
            : [...previous.users, newUser],
          auditLogs: [buildAuditLog("signup", newUser.name, "New voter signup completed through Supabase auth."), ...previous.auditLogs],
        }));
        setCurrentUserId(newUser.id);
        setView("voter");
      }

      setNotice("Account created. Check your email if Supabase requires confirmation.");
      event.currentTarget.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to create account.");
    }
  }

  async function handleSignIn(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("signinEmail")).trim().toLowerCase();
    const password = String(formData.get("signinPassword"));

    try {
      const { data: signInData, error } = await signInWithEmail({ email, password });
      if (error) throw error;
      const authUser = signInData.user;
      if (authUser) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id, full_name, email, phone, role, organization, creator_approved")
          .eq("id", authUser.id)
          .maybeSingle();

        const mappedUser = mapProfile(authUser, profile);

        setData((previous) => ({
          ...previous,
          users: previous.users.some((user) => user.id === mappedUser.id)
            ? previous.users.map((user) => (user.id === mappedUser.id ? { ...user, ...mappedUser } : user))
            : [...previous.users, mappedUser],
          auditLogs: [
            buildAuditLog("login", mappedUser.name, `Signed in with Supabase as ${roleLabels[mappedUser.role]}.`),
            ...previous.auditLogs,
          ],
        }));
        setCurrentUserId(mappedUser.id);
        setView(mappedUser.role === "super_admin" ? "admin" : mappedUser.role === "creator" ? "creator" : "voter");
        setNotice(`Signed in as ${mappedUser.name}.`);
      }
      event.currentTarget.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to sign in.");
    }
  }

  async function handlePasswordReset(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("resetEmail")).trim().toLowerCase();
    try {
      const { error } = await requestPasswordReset(email);
      if (error) throw error;
      setNotice("Password reset link requested.");
      event.currentTarget.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to request password reset.");
    }
  }

  function handleCreatorRequest(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const request = {
      id: crypto.randomUUID(),
      name: String(formData.get("name")).trim(),
      email: String(formData.get("email")).trim().toLowerCase(),
      phone: String(formData.get("phone")).trim(),
      organization: String(formData.get("organization")).trim(),
      purpose: String(formData.get("purpose")).trim(),
      status: "pending",
      rejectionReason: "",
      createdAt: new Date().toISOString(),
    };

    setData((previous) => ({
      ...previous,
      creatorRequests: [request, ...previous.creatorRequests],
      auditLogs: [buildAuditLog("request", request.name, `Requested creator access for ${request.organization}.`), ...previous.auditLogs],
    }));
    setNotice("Creator approval request submitted for admin review.");
    event.currentTarget.reset();
  }

  async function approveRequest(requestId) {
    const request = data.creatorRequests.find((item) => item.id === requestId);
    if (!request || !currentUser) return;

    const approvedCreator = {
      id: crypto.randomUUID(),
      name: request.name,
      email: request.email,
      phone: request.phone,
      role: "creator",
      organization: request.organization,
      verified: true,
      approved: true,
    };

    setData((previous) => ({
      ...previous,
      users: previous.users.some((user) => user.email === request.email)
        ? previous.users.map((user) =>
            user.email === request.email ? { ...user, role: "creator", organization: request.organization, approved: true } : user,
          )
        : [...previous.users, approvedCreator],
      creatorRequests: previous.creatorRequests.map((item) =>
        item.id === requestId ? { ...item, status: "approved", rejectionReason: "" } : item,
      ),
      notifications: [
        {
          id: crypto.randomUUID(),
          type: "approval",
          recipient: request.email,
          subject: "Your election creator request was approved",
          status: "queued",
          createdAt: new Date().toISOString(),
        },
        ...previous.notifications,
      ],
      auditLogs: [buildAuditLog("approval", currentUser.name, `Approved creator request for ${request.organization}.`), ...previous.auditLogs],
    }));

    // If Supabase is configured and available, update the user's profile there so their role reflects across sessions
    if (isSupabaseConfigured && supabase) {
      try {
        await supabase
          .from("profiles")
          .update({ role: "creator", creator_approved: true, organization: request.organization })
          .eq("email", request.email);
      } catch (err) {
        // Don't block local approval; just log a warning
        console.warn("Failed to update Supabase profile for approved creator:", err);
      }
    }

    setNotice("Creator approved and notification queued.");
  }

  function rejectRequest(requestId, reason) {
    const request = data.creatorRequests.find((item) => item.id === requestId);
    if (!request || !currentUser) return;

    setData((previous) => ({
      ...previous,
      creatorRequests: previous.creatorRequests.map((item) =>
        item.id === requestId ? { ...item, status: "rejected", rejectionReason: reason || "Does not meet platform criteria." } : item,
      ),
      notifications: [
        {
          id: crypto.randomUUID(),
          type: "rejection",
          recipient: request.email,
          subject: "Your election creator request needs revision",
          status: "queued",
          createdAt: new Date().toISOString(),
        },
        ...previous.notifications,
      ],
      auditLogs: [buildAuditLog("rejection", currentUser.name, `Rejected creator request for ${request.organization}.`), ...previous.auditLogs],
    }));
    setNotice("Request rejected with a logged reason.");
  }

  function createElection(event) {
    event.preventDefault();
    if (!currentUser || currentUser.role !== "creator") {
      setNotice("Only an approved election creator can create elections.");
      return;
    }

    const formData = new FormData(event.currentTarget);
    const election = {
      id: crypto.randomUUID(),
      codePrefix: String(formData.get("title")).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7) || "POLL",
      creatorId: currentUser.id,
      title: String(formData.get("title")).trim(),
      description: String(formData.get("description")).trim(),
      category: String(formData.get("category")).trim(),
      startAt: new Date(String(formData.get("startAt"))).toISOString(),
      endAt: new Date(String(formData.get("endAt"))).toISOString(),
      registrationDeadline: new Date(String(formData.get("registrationDeadline"))).toISOString(),
      maxVoters: Number(formData.get("maxVoters")),
      published: false,
      locked: false,
      finalizedVoterCount: 0,
      resultLocked: false,
      backendSynced: false,
      registrations: [],
      waitlist: [],
      candidates: [],
      votes: {},
    };

    if (!election.title || !election.description || !election.startAt || !election.endAt || election.maxVoters < 1) {
      setNotice("Please fill the election form with valid dates and voter limit.");
      return;
    }

    setData((previous) => ({
      ...previous,
      elections: [election, ...previous.elections],
      auditLogs: [buildAuditLog("create", currentUser.name, `Created draft election: ${election.title}.`), ...previous.auditLogs],
    }));
    setNotice("Draft election created. Add candidates, then publish it.");
    event.currentTarget.reset();
  }

  async function addCandidate(event, electionId) {
    event.preventDefault();
    if (!currentUser || currentUser.role !== "creator") return;
    const formData = new FormData(event.currentTarget);
    const photoFile = formData.get("photoFile");
    const photoUrl = String(formData.get("photoUrl")).trim();
    
    let photo = "";
    
    // Use file upload if provided, otherwise use URL
    if (photoFile && photoFile.size > 0) {
      try {
        photo = await fileToDataUrl(photoFile);
      } catch (error) {
        setNotice("Failed to upload photo. Please try again.");
        console.error("Photo upload error:", error);
        return;
      }
    } else if (photoUrl) {
      photo = photoUrl;
    } else {
      photo = `https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=320&q=80`;
    }
    
    const candidate = {
      id: crypto.randomUUID(),
      name: String(formData.get("name")).trim(),
      designation: String(formData.get("designation")).trim(),
      manifesto: String(formData.get("manifesto")).trim(),
      photo: photo,
      backendSynced: false,
    };

    if (!candidate.name || !candidate.designation || !candidate.manifesto) {
      setNotice("Candidate name, designation, and manifesto are required.");
      return;
    }

    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((election) =>
        election.id === electionId
          ? {
              ...election,
              candidates: [...election.candidates, candidate],
              votes: { ...election.votes, [candidate.id]: 0 },
            }
          : election,
      ),
      auditLogs: [buildAuditLog("candidate_add", currentUser.name, `Added ${candidate.name} as a candidate.`), ...previous.auditLogs],
    }));
    setNotice("Candidate added.");
    event.currentTarget.reset();
  }

  function deleteCandidate(electionId, candidateId) {
    if (!currentUser || currentUser.role !== "creator") return;
    const election = data.elections.find((item) => item.id === electionId);
    const candidate = election?.candidates.find((item) => item.id === candidateId);

    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((item) => {
        if (item.id !== electionId || item.published) return item;
        const nextVotes = { ...item.votes };
        delete nextVotes[candidateId];
        return {
          ...item,
          candidates: item.candidates.filter((person) => person.id !== candidateId),
          votes: nextVotes,
        };
      }),
      auditLogs: [
        buildAuditLog("candidate_delete", currentUser.name, `Deleted candidate ${candidate?.name || candidateId} from draft election.`),
        ...previous.auditLogs,
      ],
    }));
    setNotice("Candidate deleted from draft.");
  }

  function deleteElection(electionId) {
    if (!currentUser) return;
    const election = data.elections.find((e) => e.id === electionId);
    if (!election) return;

    // Only the creator or super_admin can delete an election
    if (!(currentUser.role === "super_admin" || currentUser.id === election.creatorId)) {
      setNotice("Only the election creator or a super admin may delete this election.");
      return;
    }

    if (!confirm(`Delete election '${election.title}'? This cannot be undone.`)) return;

    setData((previous) => ({
      ...previous,
      elections: previous.elections.filter((e) => e.id !== electionId),
      auditLogs: [buildAuditLog("delete", currentUser.name, `Deleted election ${election.title}.`), ...previous.auditLogs],
    }));
    setNotice("Election deleted.");
  }

  function publishElection(electionId) {
    const election = data.elections.find((item) => item.id === electionId);
    if (!currentUser || currentUser.role !== "creator" || !election) return;
    if (election.candidates.length < 2) {
      setNotice("Add at least two candidates before publishing.");
      return;
    }

    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((item) => (item.id === electionId ? { ...item, published: true } : item)),
      auditLogs: [buildAuditLog("publish", currentUser.name, `Published ${election.title}.`), ...previous.auditLogs],
    }));
    setNotice("Election published to the public landing page.");
  }

  function finalizeVoters(electionId) {
    const election = data.elections.find((item) => item.id === electionId);
    if (!election || !currentUser) return;
    const finalized = finalizeElectionRecord(election);

    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((item) => (item.id === electionId ? finalized : item)),
      notifications: [
        ...finalized.registrations.map((registration) => ({
          id: crypto.randomUUID(),
          type: "secret_id",
          recipient: registration.email,
          subject: `Your secure voter ID for ${election.title}`,
          status: "queued",
          createdAt: new Date().toISOString(),
        })),
        ...previous.notifications,
      ],
      auditLogs: [
        buildAuditLog("finalization", currentUser.name, `Finalized ${finalized.registrations.length} voters for ${election.title}.`),
        ...previous.auditLogs,
      ],
    }));
    setNotice("Voter list frozen and secret IDs queued for email.");
  }

  function toggleElectionRun(electionId, mode) {
    if (!currentUser || currentUser.role !== "creator") return;
    const election = data.elections.find((item) => item.id === electionId);
    const timestamp = new Date();
    const patch =
      mode === "start"
        ? { startAt: timestamp.toISOString(), endAt: new Date(timestamp.getTime() + 3 * 60 * 60 * 1000).toISOString() }
        : { endAt: timestamp.toISOString(), resultLocked: true };

    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((item) => (item.id === electionId ? { ...item, ...patch, published: true, locked: true } : item)),
      auditLogs: [
        buildAuditLog(mode === "start" ? "start" : "stop", currentUser.name, `${mode === "start" ? "Started" : "Stopped"} ${election.title}.`),
        ...previous.auditLogs,
      ],
    }));
    setNotice(mode === "start" ? "Election started and voting window opened." : "Election stopped and final results locked.");
  }

  function joinElection(electionId, acceptedTerms) {
    if (!currentUser) {
      setNotice("Please sign in or create a voter account before joining.");
      setView("auth");
      return;
    }

    if (!acceptedTerms) {
      setNotice("Accept the participation terms before joining an election.");
      return;
    }

    const election = data.elections.find((item) => item.id === electionId);
    if (!election) return;

    const alreadyRegistered = election.registrations.some((registration) => registration.voterId === currentUser.id);
    const alreadyWaitlisted = election.waitlist.some((registration) => registration.voterId === currentUser.id);
    if (alreadyRegistered || alreadyWaitlisted) {
      setNotice("You already joined or waitlisted for this election.");
      return;
    }

    const registration = {
      voterId: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      acceptedTerms: true,
      status: isRegistrationOpen(election, now) ? "registered" : "waitlisted",
      secretId: generateSecretId(election, currentUser.id, election.registrations.length),
      voted: false,
      joinedAt: new Date().toISOString(),
      backendSynced: false,
    };

    const isFull = election.registrations.length >= election.maxVoters;
    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((item) =>
        item.id === electionId
          ? isFull || !isRegistrationOpen(item, now)
            ? { ...item, waitlist: [...item.waitlist, { ...registration, status: "waitlisted" }] }
            : { ...item, registrations: [...item.registrations, registration] }
          : item,
      ),
      auditLogs: [
        buildAuditLog(
          isFull ? "waitlist" : "registration",
          currentUser.name,
          `${currentUser.name} requested participation in ${election.title}.`,
        ),
        ...previous.auditLogs,
      ],
    }));
    setNotice(isFull ? "The voter limit is full. You were added to the waitlist." : "Participation registered.");
  }

  function adminOverrideJoin(electionId, voterId) {
    if (!currentUser || currentUser.role !== "super_admin") return;
    const voter = data.users.find((user) => user.id === voterId);
    const election = data.elections.find((item) => item.id === electionId);
    if (!voter || !election) return;

    setData((previous) => ({
      ...previous,
      elections: previous.elections.map((item) =>
        item.id === electionId
          ? {
              ...item,
              registrations: [
                ...item.registrations,
                {
                  voterId: voter.id,
                  name: voter.name,
                  email: voter.email,
                  acceptedTerms: true,
                  status: "admin_override",
                  secretId: generateSecretId(item, voter.id, item.registrations.length),
                  voted: false,
                  joinedAt: new Date().toISOString(),
                  overrideBy: currentUser.id,
                  backendSynced: false,
                },
              ],
              finalizedVoterCount: item.finalizedVoterCount + 1,
            }
          : item,
      ),
      auditLogs: [buildAuditLog("admin_override", currentUser.name, `Added ${voter.email} to ${election.title} after lock.`), ...previous.auditLogs],
    }));
    setNotice("Admin override completed and logged.");
  }

  async function castVote(electionId, secretId, candidateId) {
    if (!currentUser) {
      setNotice("Sign in before voting.");
      return false;
    }

    const election = data.elections.find((item) => item.id === electionId);
    if (!election) return false;

    if (!canVote(election, now)) {
      setNotice("Voting is not open for this election.");
      return false;
    }

    const normalizedSecret = normalizeSecretId(secretId);
    const parsedSecret = parseSecretId(normalizedSecret);
    const registration = election.registrations.find((item) => item.voterId === currentUser.id);
    const registrationSecret = normalizeSecretId(registration?.secretId);
    const registrationSuffix = String(registration?.secret_code_suffix || registrationSecret.slice(-4)).toUpperCase();
    const secretMatchesRegistration =
      registrationSecret === normalizedSecret || (parsedSecret?.suffix && registrationSuffix === parsedSecret.suffix);

    // Log the vote attempt in audit logs so we can trace submission events in state
    setData((previous) => ({
      ...previous,
      auditLogs: [
        buildAuditLog("vote_attempt", currentUser.name, `Attempting vote on ${electionId} for candidate ${candidateId} with secret ...${normalizedSecret.slice(-6)}`),
        ...previous.auditLogs,
      ],
    }));

    if (!normalizedSecret) {
      setNotice("Enter your secret voter ID before submitting.");
      return false;
    }

    if (!registration?.secretId) {
      setNotice("Secret ID is not issued for this signed-in voter.");
      return false;
    }

    if (!secretMatchesRegistration) {
      setNotice("Secret ID is invalid for this signed-in voter.");
      return false;
    }

    if (registration.voted) {
      setNotice("Duplicate vote blocked. This secret ID has already voted.");
      return false;
    }

    if (!election.candidates.some((candidate) => candidate.id === candidateId)) {
      setNotice("Select a valid candidate before submitting.");
      return false;
    }

    async function resolveBackendVoteTarget() {
      const looksLikeUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));

      const selectedCandidate = election.candidates.find((candidate) => candidate.id === candidateId);
      if (!selectedCandidate) {
        throw new Error("Candidate could not be resolved for backend vote submission.");
      }

      if (!election.backendSynced || !selectedCandidate.backendSynced || !registration.backendSynced) {
        return null;
      }

      if (looksLikeUuid(election.id) && looksLikeUuid(candidateId)) {
        const { data: exactRow, error: exactError } = await supabase
          .from("public_election_results")
          .select("election_id,candidate_id,candidate_name,title")
          .eq("election_id", election.id)
          .eq("candidate_id", candidateId)
          .maybeSingle();

        if (exactError) {
          throw exactError;
        }

        if (exactRow) {
          return { backendElectionId: exactRow.election_id, backendCandidateId: exactRow.candidate_id };
        }
      }

      const { data: resultRows, error: resultError } = await supabase
        .from("public_election_results")
        .select("election_id,candidate_id,candidate_name,title")
        .eq("title", election.title);

      if (resultError) {
        throw resultError;
      }

      const backendElectionId = resultRows?.[0]?.election_id || null;
      const backendCandidateId = resultRows?.find((row) => row.candidate_name === selectedCandidate.name)?.candidate_id || null;

      if (!backendElectionId || !backendCandidateId) {
        return null;
      }

      return { backendElectionId, backendCandidateId };
    }

    function isSameRegistration(record) {
      return (
        (registration.id && record.id === registration.id) ||
        record.secretId === registration.secretId ||
        (record.voterId === registration.voterId && normalizeSecretId(record.secretId) === normalizedSecret)
      );
    }

    function recordLocalVote(message, acceptedSecret = normalizedSecret) {
      setData((previous) => ({
        ...previous,
        elections: previous.elections.map((item) =>
          item.id === electionId
            ? {
                ...item,
                registrations: item.registrations.map((record) =>
                  isSameRegistration(record)
                    ? { ...record, secretId: acceptedSecret || record.secretId, voted: true, votedAt: new Date().toISOString() }
                    : record,
                ),
                votes: { ...item.votes, [candidateId]: (item.votes[candidateId] || 0) + 1 },
              }
            : item,
        ),
        auditLogs: [
          buildAuditLog("vote", "Anonymous voter", `Anonymous ballot recorded for ${election.title}. Voter identity was not stored with the vote.`),
          ...previous.auditLogs,
        ],
      }));
      setNotice(message);
      return true;
    }

    // If Supabase is configured, attempt to persist the vote to the backend.
    if (isSupabaseConfigured && supabase) {
      try {
        const backendTarget = await resolveBackendVoteTarget();

        if (!backendTarget) {
          if (registrationSecret !== normalizedSecret) {
            setNotice("Secret ID is invalid for this local election.");
            return false;
          }

          return recordLocalVote("Vote recorded locally. This election is running in local browser state.");
        }

        const { backendElectionId, backendCandidateId } = backendTarget;
        const secretCandidates = buildSecretVoteCandidates(election, registration, normalizedSecret);
        let lastSecretVoteError = "";

        for (const secretCandidate of secretCandidates) {
          const { data, error } = await supabase.rpc("cast_vote", {
            p_election_id: backendElectionId,
            p_candidate_id: backendCandidateId,
            p_secret_code: secretCandidate,
          });

          if (error) {
            const message = error.message || "Failed to record vote on server.";
            if (isPgcryptoDigestError(message)) {
              return recordLocalVote(
                "Vote recorded locally. For Supabase persistence, run supabase/fix-vote-rpc.sql in the Supabase SQL editor.",
                secretCandidate,
              );
            }
            if (isSecretVoteError(message)) {
              lastSecretVoteError = message;
              continue;
            }
            setNotice(message);
            return false;
          }

          if (!data) {
            setNotice("Vote was not accepted by the backend.");
            return false;
          }

          // On success, update local state so UI reflects the change immediately.
          setData((previous) => ({
            ...previous,
            elections: previous.elections.map((item) =>
              item.id === electionId
                ? {
                    ...item,
                    registrations: item.registrations.map((record) =>
                      isSameRegistration(record)
                        ? { ...record, secretId: secretCandidate, voted: true, votedAt: new Date().toISOString() }
                        : record,
                    ),
                    votes: { ...item.votes, [candidateId]: (item.votes[candidateId] || 0) + 1 },
                  }
                : item,
            ),
            auditLogs: [
              buildAuditLog("vote", "Anonymous voter", `Anonymous ballot recorded for ${election.title}.`),
              ...previous.auditLogs,
            ],
          }));

          setNotice("Vote recorded. Your ballot is anonymous and duplicate voting is blocked.");
          return true;
        }

        if (lastSecretVoteError) {
          setNotice("Secret ID was not accepted by Supabase. Run supabase/fix-vote-rpc.sql in the Supabase SQL editor, refresh, then try again.");
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to record vote.";
        if (isPgcryptoDigestError(message)) {
          return recordLocalVote(
            "Vote recorded locally. For Supabase persistence, run supabase/fix-vote-rpc.sql in the Supabase SQL editor.",
          );
        }
        if (isSecretVoteError(message)) {
          setNotice("Secret ID was not accepted by Supabase. Refresh and try again; if it still happens, run supabase/fix-vote-rpc.sql in the Supabase SQL editor.");
          return false;
        }
        setNotice(message);
        return false;
      }
    }

    // Fallback: no backend configured — persist in local demo state
    return recordLocalVote("Vote recorded (local demo). Your ballot is anonymous and duplicate voting is blocked.");
  }

  function downloadLogs() {
    const blob = new Blob([JSON.stringify(data.auditLogs, null, 2)], { type: "application/json" });
    triggerDownload(blob, "audit-logs.json");
    setNotice("Audit logs downloaded.");
  }

  function downloadResultPdf(electionId) {
    const election = data.elections.find((item) => item.id === electionId);
    if (!election) return;
    const pdf = new jsPDF();
    const winner = getWinner(election);
    pdf.setFontSize(18);
    pdf.text("Election Result Report", 14, 20);
    pdf.setFontSize(12);
    pdf.text(election.title, 14, 32);
    pdf.text(`Category: ${election.category}`, 14, 40);
    pdf.text(`Turnout: ${getTurnout(election)}%`, 14, 48);
    pdf.text(`Winner: ${winner?.name || "No winner yet"}`, 14, 56);
    getResults(election).forEach((candidate, index) => {
      pdf.text(`${index + 1}. ${candidate.name} - ${candidate.votes} votes (${candidate.percent}%)`, 14, 70 + index * 8);
    });
    pdf.save(`${election.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-results.pdf`);
    setNotice("Result PDF generated.");
  }

  return (
    <div className={darkMode ? "app theme-dark" : "app"}>
      <header className="topbar">
        <div className="brand" onClick={() => setView("landing")} role="button" tabIndex={0}>
          <span className="brand-mark">
            <ShieldCheck size={22} />
          </span>
          <span>
            <strong>SecureVote</strong>
            <small>Online Election Management</small>
          </span>
        </div>

        <nav className="main-nav" aria-label="Primary">
          <button className={view === "landing" ? "active" : ""} onClick={() => setView("landing")}>
            <Eye size={16} /> Elections
          </button>
          <button className={view === "auth" ? "active" : ""} onClick={() => { setAccessView("chooser"); setView("auth"); }}>
            <LogIn size={16} /> Access
          </button>
          <button className={view === "audit" ? "active" : ""} onClick={() => setView("audit")}>
            <Activity size={16} /> Audit
          </button>
          <button className={view === "security" ? "active" : ""} onClick={() => setView("security")}>
            <Lock size={16} /> Security
          </button>
          {currentUser && (
            <button className={view === dashboardTarget ? "active" : ""} onClick={() => setView(dashboardTarget)}>
              <BarChart3 size={16} /> Dashboard
            </button>
          )}
        </nav>

        <div className="session-tools">
          <button
            className="icon-button mobile-menu-toggle"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Open menu"
            aria-expanded={mobileMenuOpen}
          >
            ☰
          </button>
          <button className="icon-button" onClick={() => setDarkMode((value) => !value)} aria-label="Toggle dark mode">
            <Moon size={18} />
          </button>
          {currentUser ? (
            <div className="profile-pill">
              <span>{currentUser.name}</span>
              <small>{roleLabels[currentUser.role]}</small>
              <button className="icon-button" onClick={handleLogout} aria-label="Logout">
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button className="primary-button" onClick={() => setView("login") }>
              <LogIn size={16} /> Sign in
            </button>
          )}
        </div>
      </header>

      {mobileMenuOpen && <div className="mobile-menu-backdrop" onClick={() => setMobileMenuOpen(false)} />}

      <aside className={`mobile-menu ${mobileMenuOpen ? "open" : ""}`} role="menu" aria-hidden={!mobileMenuOpen}>
        <div className="mobile-menu-inner">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.6rem 0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span className="brand-mark"><ShieldCheck size={18} /></span>
              <strong>SecureVote</strong>
            </div>
            <button className="icon-button mobile-menu-close" onClick={() => setMobileMenuOpen(false)} aria-label="Close menu">×</button>
          </div>

          <nav className="mobile-nav" aria-label="Mobile primary">
            <button onClick={() => { setView("landing"); setMobileMenuOpen(false); }}>
              <Eye size={18} /> Elections
            </button>
            <button onClick={() => { setAccessView("chooser"); setView("auth"); setMobileMenuOpen(false); }}>
              <LogIn size={18} /> Access
            </button>
            <button onClick={() => { setView("audit"); setMobileMenuOpen(false); }}>
              <Activity size={18} /> Audit
            </button>
            <button onClick={() => { setView("security"); setMobileMenuOpen(false); }}>
              <Lock size={18} /> Security
            </button>
            {currentUser && (
              <button onClick={() => { setView(dashboardTarget); setMobileMenuOpen(false); }}>
                <BarChart3 size={18} /> Dashboard
              </button>
            )}
          </nav>
        </div>
      </aside>

      <main>
        {notice && noticeVisible && (
          <section className="notice-strip">
            <span className={isSupabaseConfigured ? "status-dot online" : "status-dot"} />
            <span>{notice}</span>
            {isSupabaseConfigured && <small className="muted-copy">Supabase auth active</small>}
            <button className="icon-button notice-close" onClick={() => setNoticeVisible(false)} aria-label="Dismiss notice">×</button>
          </section>
        )}

        {view === "landing" && (
          <LandingPage
            metrics={metrics}
            elections={filteredElections}
            currentUser={currentUser}
            now={now}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            onJoin={joinElection}
            onVote={castVote}
            onPdf={downloadResultPdf}
            onNotice={setNotice}
          />
        )}

        {view === "login" && (
          <LoginScreen
            onSignIn={handleSignIn}
            onOpenSignup={() => {
              setAccessView("signup");
              setView("auth");
            }}
            onForgotPassword={() => {
              setAccessView("reset");
              setView("auth");
            }}
            onOpenCreatorRequest={() => {
              setAccessView("creator");
              setView("auth");
            }}
          />
        )}

        {view === "auth" && (
          <>
            {accessView === "chooser" && (
              <AuthPanel currentUser={currentUser} onViewChange={setAccessView} onLogout={handleLogout} />
            )}
            {accessView === "signup" && (
              <SignupScreen
                onSignup={handleSignup}
                onOpenLogin={() => setView("login")}
                onOpenCreator={() => setAccessView("creator")}
              />
            )}
            {accessView === "creator" && (
              <CreatorRequestScreen
                onCreatorRequest={handleCreatorRequest}
                onOpenLogin={() => setView("login")}
                onOpenSignup={() => setAccessView("signup")}
              />
            )}
            {accessView === "reset" && <PasswordResetScreen onPasswordReset={handlePasswordReset} onOpenLogin={() => setView("login")} />}
          </>
        )}

        {view === "admin" && (
          <Protected allowed="super_admin" currentUser={currentUser} onAccess={() => setView("login")}>
            <AdminDashboard
              data={data}
              now={now}
              metrics={metrics}
              onApprove={approveRequest}
              onReject={rejectRequest}
              onOverrideJoin={adminOverrideJoin}
              onDownloadLogs={downloadLogs}
            />
          </Protected>
        )}

        {view === "creator" && (
          <Protected allowed="creator" currentUser={currentUser} onAccess={() => setView("login")}>
            <CreatorDashboard
              data={data}
              now={now}
              currentUser={currentUser}
              onCreateElection={createElection}
              onAddCandidate={addCandidate}
              onDeleteCandidate={deleteCandidate}
              onDeleteElection={deleteElection}
              onPublish={publishElection}
              onFinalize={finalizeVoters}
              onRun={toggleElectionRun}
              onPdf={downloadResultPdf}
            />
          </Protected>
        )}

        {view === "voter" && (
          <Protected allowed="voter" currentUser={currentUser} onAccess={() => setView("login")}>
            <VoterDashboard data={data} now={now} currentUser={currentUser} onVote={castVote} onPdf={downloadResultPdf} onNotice={setNotice} />
          </Protected>
        )}

        {view === "audit" && (
          <AuditDashboard
            logs={data.auditLogs}
            notifications={data.notifications}
            onDownloadLogs={downloadLogs}
            onClearNotices={() => {
              setNotice("");
              setNoticeVisible(false);
            }}
          />
        )}

        {view === "security" && <SecurityDashboard />}
      </main>
    </div>
  );
}

function finalizeElectionRecord(election) {
  const registrations = election.registrations.map((registration, index) => ({
    ...registration,
    status: registration.status === "admin_override" ? "admin_override" : "finalized",
    secretId: registration.secretId || generateSecretId(election, registration.voterId, index),
  }));

  return {
    ...election,
    locked: true,
    finalizedVoterCount: registrations.length,
    registrations,
  };
}

function Protected({ allowed, currentUser, onAccess, children }) {
  if (!currentUser || currentUser.role !== allowed) {
    return (
      <section className="empty-state">
        <Lock size={38} />
        <h2>Protected route</h2>
        <p>Sign in with a {roleLabels[allowed]} account to open this dashboard.</p>
        <button className="primary-button" onClick={onAccess}>
          <LogIn size={16} /> Open access panel
        </button>
      </section>
    );
  }

  return children;
}

function LandingPage({
  metrics,
  elections,
  currentUser,
  now,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  onJoin,
  onVote,
  onPdf,
  onNotice,
}) {
  return (
    <div className="page-stack">
      <section className="control-room">
        <div>
          <p className="eyebrow">Live public election board</p>
          <h1>Transparent elections with verified voters and anonymous ballots.</h1>
          <p>
            Browse active, upcoming, and completed polls. Eligible voters can opt in during the registration window, receive a
            secret ID after finalization, and cast exactly one vote during the live timer.
          </p>
        </div>
        <div className="metric-grid compact">
          <Metric icon={<Flag />} label="Elections" value={metrics.totalElections} />
          <Metric icon={<Timer />} label="Active" value={metrics.active} />
          <Metric icon={<Users />} label="Users" value={metrics.users} />
          <Metric icon={<Vote />} label="Votes" value={metrics.votes} />
        </div>
      </section>

      <section className="toolbar-panel">
        <div className="search-box">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search elections, categories, purpose" />
        </div>
        <div className="segmented-control">
          {["all", "upcoming", "active", "completed"].map((status) => (
            <button className={statusFilter === status ? "active" : ""} key={status} onClick={() => setStatusFilter(status)}>
              {status}
            </button>
          ))}
        </div>
      </section>

      <section className="election-grid">
        {elections.map((election) => (
          <ElectionCard
            key={election.id}
            election={election}
            now={now}
            currentUser={currentUser}
            onJoin={onJoin}
            onVote={onVote}
            onPdf={onPdf}
            onNotice={onNotice}
          />
        ))}
      </section>
    </div>
  );
}

function ElectionCard({ election, now, currentUser, onJoin, onVote, onPdf, onNotice }) {
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [candidateId, setCandidateId] = useState(election.candidates[0]?.id || "");
  const status = getElectionStatus(election, now);
  const results = getResults(election);
  const winner = getWinner(election);
  const registration = currentUser
    ? election.registrations.find((record) => record.voterId === currentUser.id) ||
      election.waitlist.find((record) => record.voterId === currentUser.id)
    : null;
  const registrationOpen = isRegistrationOpen(election, now);
  const voteOpen = canVote(election, now);

  return (
    <article className="election-card">
      <div className="card-header">
        <div>
          <span className={`status-badge ${status}`}>{status}</span>
          <h2>{election.title}</h2>
          <p>{election.description}</p>
        </div>
        <span className="category-tag">{election.category}</span>
      </div>

      <div className="candidate-strip">
        {election.candidates.slice(0, 4).map((candidate) => (
          <img key={candidate.id} src={candidate.photo} alt={candidate.name} />
        ))}
      </div>

      <div className="timeline-grid">
        <InfoItem label="Registration" value={formatDateTime(election.registrationDeadline)} />
        <InfoItem label="Starts" value={formatDateTime(election.startAt)} />
        <InfoItem label="Ends" value={formatDateTime(election.endAt)} />
        <InfoItem label="Timer" value={status === "upcoming" ? formatCountdown(election.startAt, now) : formatCountdown(election.endAt, now)} />
      </div>

      <div className="progress-block">
        <div className="progress-label">
          <span>Voter limit</span>
          <strong>
            {election.registrations.length}/{election.maxVoters}
          </strong>
        </div>
        <div className="progress-track">
          <span style={{ width: `${Math.min(100, Math.round((election.registrations.length / election.maxVoters) * 100))}%` }} />
        </div>
      </div>

      <div className="action-zone">
        {registration ? (
          <div className="inline-status success">
            <UserCheck size={16} />
            {registration.status === "waitlisted"
              ? "You are on the waitlist"
              : `Joined - Secret ID: ${maskSecretId(registration.secretId)}`}
          </div>
        ) : (
          <>
            <label className="checkline">
              <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
              <span>I accept participation terms and eligibility checks.</span>
            </label>
            <button className="primary-button" disabled={!registrationOpen} onClick={() => onJoin(election.id, acceptedTerms)}>
              <UserCheck size={16} />
              {registrationOpen ? "I Want to Participate" : "Registration closed"}
            </button>
          </>
        )}
      </div>

      {registration?.secretId && !registration.voted && (
        <form
          className="vote-box"
          onSubmit={async (event) => {
            event.preventDefault();
            // If voting not allowed, show clear message and block
            if (!voteOpen) {
              onNotice?.(status === "upcoming" ? "Voting has not started yet." : "Voting is closed for this election.");
              return;
            }
            const formData = new FormData(event.currentTarget);
            const submittedSecret = String(formData.get("secretId") || registration.secretId || "");
            await onVote(election.id, submittedSecret, candidateId || election.candidates[0]?.id || "");
          }}
        >
          <label>
            Secret voter ID
            <input
              name="secretId"
              defaultValue={registration.secretId || ""}
              onInput={(event) => {
                event.currentTarget.value = event.currentTarget.value.toUpperCase();
              }}
              placeholder="POLL-A-0001"
              autoComplete="off"
              spellCheck="false"
            />
          </label>
          <label>
            Candidate
            <select value={candidateId} onChange={(event) => setCandidateId(event.target.value)}>
              {election.candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              className="primary-button"
              type="submit"
              disabled={!voteOpen}
            >
              <Vote size={16} /> Cast anonymous vote
            </button>
            {!voteOpen && status === "upcoming" && <div className="muted">Voting has not started yet.</div>}
            {!voteOpen && status === "completed" && <div className="muted">Voting has ended for this election.</div>}
          </div>
        </form>
      )}

      {registration?.voted && (
        <div className="inline-status success">
          <CheckCircle2 size={16} /> Vote confirmed. Duplicate vote prevention is active.
        </div>
      )}

      {(status === "active" || status === "completed") && (
        <div className="results-preview">
          <div className="result-heading">
            <div>
              <strong>Live results</strong>
              <span>{getVoteTotal(election)} votes, {getTurnout(election)}% turnout</span>
            </div>
            <button className="ghost-button" onClick={() => onPdf(election.id)}>
              <Download size={15} /> PDF
            </button>
          </div>
          {winner && (
            <div className="winner-line">
              <Flag size={16} /> Current winner: <strong>{winner.name}</strong>
            </div>
          )}
          <div className="bar-list">
            {results.map((candidate, index) => (
              <div className="bar-row" key={candidate.id}>
                <span>{candidate.name}</span>
                <div className="bar-track">
                  <span style={{ width: `${candidate.percent}%`, background: CHART_COLORS[index % CHART_COLORS.length] }} />
                </div>
                <strong>{candidate.votes}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function AuthPanel({ currentUser, view, onViewChange, onSignup, onCreatorRequest, onLogout, onPasswordReset, onOpenLogin }) {
  return (
    <div className="auth-screen">
      <section className="panel auth-login-card">
        <div className="auth-login-header">
          <span className="auth-lock-icon">
            <Users size={24} />
          </span>
          <div>
            <p className="eyebrow">Access options</p>
            <h2>Choose an account action</h2>
            <p>Pick one form at a time to create a voter account, request creator access, or reset your password.</p>
          </div>
          {currentUser && (
            <button className="ghost-button" onClick={onLogout}>
              <LogOut size={16} /> Logout
            </button>
          )}
        </div>

        <div className="access-actions">
          <button className="primary-button" type="button" onClick={() => onViewChange("signup")}>
            <Mail size={16} /> Create voter account
          </button>
          <button className="ghost-button" type="button" onClick={() => onViewChange("creator")}>
            <FileText size={16} /> Request election creator access
          </button>
          <button className="ghost-button" type="button" onClick={() => onViewChange("reset")}>
            <Mail size={16} /> Forgot password?
          </button>
        </div>
      </section>
    </div>
  );
}

function SignupScreen({ onSignup, onOpenLogin, onOpenCreator }) {
  const [showSignupPassword, setShowSignupPassword] = useState(false);

  return (
    <div className="auth-screen">
      <section className="panel auth-login-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Voter signup</p>
            <h2>Create voter account</h2>
          </div>
        </div>
        <form className="form-stack" onSubmit={onSignup}>
          <input name="name" placeholder="Full name" required />
          <input name="email" placeholder="Email address" type="email" required />
          <input name="phone" placeholder="Phone number" required />
          <div className="password-row">
            <input name="password" placeholder="Password" type={showSignupPassword ? "text" : "password"} required minLength={8} />
            <button
              type="button"
              className="icon-button password-toggle"
              onClick={() => setShowSignupPassword((s) => !s)}
              aria-label={showSignupPassword ? "Hide password" : "Show password"}
            >
              {showSignupPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <button className="primary-button" type="submit">
            <Mail size={16} /> Signup and verify email
          </button>
          <button type="button" className="text-link" onClick={onOpenLogin}>
            Already have an account? Sign in
          </button>
          <button type="button" className="text-link" onClick={onOpenCreator}>
            Request election creator access
          </button>
        </form>
      </section>
    </div>
  );
}

function CreatorRequestScreen({ onCreatorRequest, onOpenLogin, onOpenSignup }) {
  return (
    <div className="auth-screen">
      <section className="panel auth-login-card">
        <div className="auth-login-header">
          <span className="auth-lock-icon">
            <FileText size={24} />
          </span>
          <div>
            <p className="eyebrow">Creator approval</p>
            <h2>Request election creator access</h2>
            <p>Submit your details for admin review to get creator permissions.</p>
          </div>
        </div>
        <form className="form-stack" onSubmit={onCreatorRequest}>
          <input name="name" placeholder="Full name" required />
          <input name="email" placeholder="Email address" type="email" required />
          <input name="phone" placeholder="Phone number" required />
          <input name="organization" placeholder="Organization" required />
          <textarea name="purpose" placeholder="Election purpose" required />
          <button className="primary-button" type="submit">
            <FileText size={16} /> Submit for approval
          </button>
          <button type="button" className="text-link" onClick={onOpenLogin}>
            Back to sign in
          </button>
          <button type="button" className="text-link" onClick={onOpenSignup}>
            Need a voter account? Create voter account
          </button>
        </form>
      </section>
    </div>
  );
}

function PasswordResetScreen({ onPasswordReset, onOpenLogin }) {
  return (
    <div className="auth-screen">
      <section className="panel auth-login-card">
        <div className="auth-login-header">
          <span className="auth-lock-icon">
            <Lock size={24} />
          </span>
          <div>
            <p className="eyebrow">Password reset</p>
            <h2>Send reset link</h2>
            <p>Supabase handles reset links and email verification when environment variables are configured.</p>
          </div>
        </div>
        <form className="form-stack" onSubmit={onPasswordReset}>
          <input name="resetEmail" placeholder="Email address" type="email" required />
          <button className="ghost-button" type="submit">
            <Mail size={16} /> Send reset link
          </button>
          <button type="button" className="text-link" onClick={onOpenLogin}>
            Back to sign in
          </button>
        </form>
      </section>
    </div>
  );
}

function LoginScreen({ onSignIn, onOpenSignup, onForgotPassword, onOpenCreatorRequest }) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="auth-screen">
      <section className="panel auth-login-card">
        <div className="auth-login-header">
          <span className="auth-lock-icon">
            <Lock size={24} />
          </span>
          <div>
            <p className="eyebrow">Institutional Login</p>
            <h2>Authenticate Session</h2>
            <p>Secure access for approved users with email verification and role-based sign-in.</p>
          </div>
        </div>
        <form className="form-stack" onSubmit={onSignIn}>
          <input name="signinEmail" placeholder="Email address" type="email" required />
          <div className="password-row">
            <input name="signinPassword" placeholder="Password" type={showPassword ? "text" : "password"} required />
            <button
              type="button"
              className="icon-button password-toggle"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <button type="button" className="text-link" onClick={onForgotPassword}>
            Forgot password?
          </button>
          <label className="field-label">
            Login role
            <select name="loginRole" defaultValue="voter">
              <option value="voter">Voter</option>
              <option value="creator">Election Creator</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </label>
          <button className="primary-button" type="submit">
            <LogIn size={16} /> Authenticate Session
          </button>
          <button type="button" className="text-link" onClick={onOpenSignup}>
            Need an account? Create voter account
          </button>
          <button type="button" className="text-link" onClick={onOpenCreatorRequest}>
            Request election creator access
          </button>
        </form>
      </section>
    </div>
  );
}

function AdminDashboard({ data, now, metrics, onApprove, onReject, onOverrideJoin, onDownloadLogs }) {
  const [reasonById, setReasonById] = useState({});
  const voterOptions = data.users.filter((user) => user.role === "voter");
  const [overrideElection, setOverrideElection] = useState(data.elections[0]?.id || "");
  const [overrideVoter, setOverrideVoter] = useState(voterOptions[0]?.id || "");

  return (
    <div className="page-stack">
      <section className="metric-grid">
        <Metric icon={<Flag />} label="Total elections" value={metrics.totalElections} />
        <Metric icon={<Timer />} label="Active" value={metrics.active} />
        <Metric icon={<Users />} label="Total users" value={metrics.users} />
        <Metric icon={<Activity />} label="Avg turnout" value={`${metrics.turnout}%`} />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Admin approval module</p>
            <h2>Election creator requests</h2>
          </div>
          <button className="ghost-button" onClick={onDownloadLogs}>
            <Download size={16} /> Download logs
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Creator</th>
                <th>Organization</th>
                <th>Purpose</th>
                <th>Status</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.creatorRequests.map((request) => (
                <tr key={request.id}>
                  <td>
                    <strong>{request.name}</strong>
                    <span>{request.email}</span>
                    <span>{request.phone}</span>
                  </td>
                  <td>{request.organization}</td>
                  <td>{request.purpose}</td>
                  <td>
                    <span className={`status-badge ${request.status}`}>{request.status}</span>
                    {request.rejectionReason && <small>{request.rejectionReason}</small>}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="success-button" disabled={request.status === "approved"} onClick={() => onApprove(request.id)}>
                        <CheckCircle2 size={15} /> Approve
                      </button>
                      <input
                        value={reasonById[request.id] || ""}
                        onChange={(event) => setReasonById({ ...reasonById, [request.id]: event.target.value })}
                        placeholder="Reason"
                      />
                      <button className="danger-button" onClick={() => onReject(request.id, reasonById[request.id])}>
                        <XCircle size={15} /> Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dashboard-grid">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Approved elections</p>
              <h2>Platform overview</h2>
            </div>
          </div>
          <div className="stack-list">
            {data.elections.map((election) => (
              <div className="list-item" key={election.id}>
                <div>
                  <strong>{election.title}</strong>
                  <span>
                    {getElectionStatus(election, now)} - {election.registrations.length}/{election.maxVoters} voters
                  </span>
                </div>
                <span className={election.locked ? "lock-state locked" : "lock-state"}>
                  {election.locked ? <Lock size={14} /> : <Unlock size={14} />}
                  {election.locked ? "locked" : "open"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Admin override</p>
              <h2>Logged voter override</h2>
            </div>
          </div>
          <div className="form-stack">
            <select value={overrideElection} onChange={(event) => setOverrideElection(event.target.value)}>
              {data.elections.map((election) => (
                <option key={election.id} value={election.id}>
                  {election.title}
                </option>
              ))}
            </select>
            <select value={overrideVoter} onChange={(event) => setOverrideVoter(event.target.value)}>
              {voterOptions.map((voter) => (
                <option key={voter.id} value={voter.id}>
                  {voter.name} ({voter.email})
                </option>
              ))}
            </select>
            <button className="primary-button" onClick={() => onOverrideJoin(overrideElection, overrideVoter)}>
              <ShieldCheck size={16} /> Add with audit log
            </button>
            <p className="muted-copy">Override actions are recorded with actor, timestamp, and election details.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function CreatorDashboard({ data, now, currentUser, onCreateElection, onAddCandidate, onDeleteCandidate, onDeleteElection, onPublish, onFinalize, onRun, onPdf }) {
  const myElections = data.elections.filter((election) => election.creatorId === currentUser.id);

  return (
    <div className="page-stack">
      <section className="dashboard-grid">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Election creation module</p>
              <h2>Create new election</h2>
            </div>
          </div>
          <form className="form-stack" onSubmit={onCreateElection}>
            <input name="title" defaultValue={defaultElectionForm.title} placeholder="Election title" required />
            <textarea name="description" defaultValue={defaultElectionForm.description} placeholder="Election description" required />
            <input name="category" defaultValue={defaultElectionForm.category} placeholder="Category" required />
            <label>
              Registration deadline
              <input name="registrationDeadline" type="datetime-local" required />
            </label>
            <label>
              Start date and time
              <input name="startAt" type="datetime-local" required />
            </label>
            <label>
              End date and time
              <input name="endAt" type="datetime-local" required />
            </label>
            <label>
              Max voters
              <input name="maxVoters" type="number" min="1" defaultValue={defaultElectionForm.maxVoters} required />
            </label>
            <button className="primary-button" type="submit">
              <Plus size={16} /> Create draft
            </button>
          </form>
        </div>

        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Analytics</p>
              <h2>My election status</h2>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={[
                  { name: "Draft", value: myElections.filter((election) => !election.published).length },
                  { name: "Upcoming", value: myElections.filter((election) => getElectionStatus(election, now) === "upcoming").length },
                  { name: "Active", value: myElections.filter((election) => getElectionStatus(election, now) === "active").length },
                  { name: "Completed", value: myElections.filter((election) => getElectionStatus(election, now) === "completed").length },
                ]}
                dataKey="value"
                nameKey="name"
                outerRadius={84}
                label
              >
                {CHART_COLORS.map((color) => (
                  <Cell key={color} fill={color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="creator-election-list">
        {myElections.map((election) => (
          <CreatorElectionPanel
            key={election.id}
            election={election}
            now={now}
            onAddCandidate={onAddCandidate}
            onDeleteCandidate={onDeleteCandidate}
            onDeleteElection={onDeleteElection}
            onPublish={onPublish}
            onFinalize={onFinalize}
            onRun={onRun}
            onPdf={onPdf}
          />
        ))}
      </section>
    </div>
  );
}

function CreatorElectionPanel({ election, now, onAddCandidate, onDeleteCandidate, onDeleteElection, onPublish, onFinalize, onRun, onPdf }) {
  const status = getElectionStatus(election, now);
  const results = getResults(election);
  const winner = getWinner(election);

  return (
    <article className="panel election-manager">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{status}</p>
          <h2>{election.title}</h2>
          <p>{election.description}</p>
        </div>
        <div className="row-actions">
          {!election.published && (
            <button className="primary-button" onClick={() => onPublish(election.id)}>
              <Flag size={16} /> Publish
            </button>
          )}
          {!election.locked && (
            <button className="ghost-button" onClick={() => onFinalize(election.id)}>
              <KeyRound size={16} /> Finalize voters
            </button>
          )}
          <button className="success-button" onClick={() => onRun(election.id, "start")}>
            <Timer size={16} /> Start
          </button>
          <button className="danger-button" onClick={() => onRun(election.id, "stop")}>
            <Lock size={16} /> Stop
          </button>
          <button className="ghost-button" onClick={() => onPdf(election.id)}>
            <Download size={16} /> PDF
          </button>
          <button
            className="danger-button"
            onClick={() => {
              if (typeof onDeleteElection === "function") {
                onDeleteElection(election.id);
              }
            }}
          >
            <XCircle size={16} /> Delete
          </button>
        </div>
      </div>

      <div className="manager-grid">
        <div>
          <div className="timeline-grid">
            <InfoItem label="Registration deadline" value={formatDateTime(election.registrationDeadline)} />
            <InfoItem label="Start" value={formatDateTime(election.startAt)} />
            <InfoItem label="End" value={formatDateTime(election.endAt)} />
            <InfoItem label="Voters" value={`${election.registrations.length}/${election.maxVoters}`} />
          </div>

          <h3>Candidates</h3>
          <div className="candidate-list">
            {election.candidates.map((candidate) => (
              <div className="candidate-row" key={candidate.id}>
                <img src={candidate.photo} alt={candidate.name} />
                <div>
                  <strong>{candidate.name}</strong>
                  <span>{candidate.designation}</span>
                  <small>{candidate.manifesto}</small>
                </div>
                {!election.published && (
                  <button className="icon-button danger" onClick={() => onDeleteCandidate(election.id, candidate.id)} aria-label="Delete candidate">
                    <XCircle size={17} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {!election.published && (
            <form className="candidate-form" onSubmit={(event) => onAddCandidate(event, election.id)}>
              <input name="name" defaultValue={defaultCandidateForm.name} placeholder="Candidate name" required />
              <input name="designation" defaultValue={defaultCandidateForm.designation} placeholder="Designation" required />
              <div className="photo-input-group">
                <div className="photo-input-option">
                  <label htmlFor="photoFile" className="photo-label">Upload Photo (Local)</label>
                  <input id="photoFile" type="file" name="photoFile" accept="image/*" />
                </div>
                <div className="photo-input-divider">or</div>
                <div className="photo-input-option">
                  <label htmlFor="photoUrl" className="photo-label">Photo URL (Online)</label>
                  <input id="photoUrl" type="url" name="photoUrl" placeholder="https://example.com/photo.jpg" />
                </div>
              </div>
              <textarea name="manifesto" defaultValue={defaultCandidateForm.manifesto} placeholder="Manifesto or description" required />
              <button className="primary-button" type="submit">
                <Plus size={16} /> Add candidate
              </button>
            </form>
          )}
        </div>

        <div className="result-card">
          <div className="result-heading">
            <div>
              <strong>Creator result view</strong>
              <span>{getVoteTotal(election)} votes, winner details shown here</span>
            </div>
          </div>
          {winner && (
            <div className="winner-panel">
              <img src={winner.photo} alt={winner.name} />
              <div>
                <span>Winner</span>
                <strong>{winner.name}</strong>
                <small>{winner.votes} votes</small>
              </div>
            </div>
          )}
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={results}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="votes" radius={[6, 6, 0, 0]}>
                {results.map((_, index) => (
                  <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </article>
  );
}

function VoterDashboard({ data, now, currentUser, onVote, onPdf, onNotice }) {
  const joined = data.elections.filter(
    (election) =>
      election.registrations.some((registration) => registration.voterId === currentUser.id) ||
      election.waitlist.some((registration) => registration.voterId === currentUser.id),
  );

  return (
    <div className="page-stack">
      <section className="metric-grid">
        <Metric icon={<ClipboardList />} label="Joined polls" value={joined.length} />
        <Metric
          icon={<KeyRound />}
          label="Secret IDs"
          value={joined.filter((election) => election.registrations.some((registration) => registration.voterId === currentUser.id && registration.secretId)).length}
        />
        <Metric
          icon={<Vote />}
          label="Votes cast"
          value={joined.filter((election) => election.registrations.some((registration) => registration.voterId === currentUser.id && registration.voted)).length}
        />
        <Metric icon={<Timer />} label="Open now" value={joined.filter((election) => canVote(election, now)).length} />
      </section>

      <section className="election-grid">
        {joined.length === 0 ? (
          <div className="empty-state full">
            <Vote size={38} />
            <h2>No joined polls yet</h2>
            <p>Open the public election board and click I Want to Participate during a registration window.</p>
          </div>
        ) : (
          joined.map((election) => (
            <ElectionCard key={election.id} election={election} now={now} currentUser={currentUser} onJoin={() => {}} onVote={onVote} onPdf={onPdf} onNotice={onNotice} />
          ))
        )}
      </section>
    </div>
  );
}

function AuditDashboard({ logs, notifications, onDownloadLogs, onClearNotices }) {
  return (
    <div className="dashboard-grid">
      <section className="panel wide-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Audit and transparency module</p>
            <h2>Action logs</h2>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button className="ghost-button" onClick={onDownloadLogs}>
              <Download size={16} /> Download logs
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                if (typeof onClearNotices === 'function') onClearNotices();
              }}
            >
              Clear all
            </button>
          </div>
        </div>
        <div className="timeline-list">
          {logs.map((log) => (
            <div className="timeline-item" key={log.id}>
              <span className="timeline-dot" />
              <div>
                <strong>{log.action}</strong>
                <p>{log.detail}</p>
                <small>
                  {log.actor} - {formatDateTime(log.createdAt)} - {log.ipAddress}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Notification module</p>
            <h2>Email queue</h2>
          </div>
        </div>
        <div className="stack-list">
          {notifications.map((mail) => (
            <div className="list-item" key={mail.id}>
              <Bell size={18} />
              <div>
                <strong>{mail.subject}</strong>
                <span>{mail.recipient}</span>
                <small>
                  {mail.type} - {mail.status} - {formatDateTime(mail.createdAt)}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SecurityDashboard() {
  const controls = [
    {
      title: "Row Level Security",
      detail: "Policies in supabase/schema.sql separate super admin, creator, voter, and anonymous-result access.",
      icon: <ShieldCheck />,
    },
    {
      title: "Duplicate vote prevention",
      detail: "A unique secret ID is issued per poll and marked used after a ballot is stored.",
      icon: <Vote />,
    },
    {
      title: "Anonymous voting",
      detail: "Audit entries record vote events without candidate or voter identity. Vote totals are stored separately.",
      icon: <Eye />,
    },
    {
      title: "Input validation",
      detail: "Forms validate required fields, voter limits, email format, and voting windows before state changes.",
      icon: <ClipboardList />,
    },
    {
      title: "Rate limits and CAPTCHA",
      detail: "Production deployment can enable Supabase Auth CAPTCHA and edge-function rate limits for sensitive endpoints.",
      icon: <Lock />,
    },
    {
      title: "Audit exports",
      detail: "Admin actions, approvals, finalization, overrides, and votes produce timestamped downloadable logs.",
      icon: <Download />,
    },
  ];

  return (
    <div className="page-stack">
      <section className="control-room small">
        <div>
          <p className="eyebrow">Security module</p>
          <h1>Controls mapped to the project rubric.</h1>
          <p>
            The UI demonstrates the full flow while the Supabase schema provides production tables, RLS policies, and server-side
            functions for secret code issuance and vote recording.
          </p>
        </div>
      </section>
      <section className="security-grid">
        {controls.map((control) => (
          <article className="security-card" key={control.title}>
            <span>{control.icon}</span>
            <h2>{control.title}</h2>
            <p>{control.detail}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

function Metric({ icon, label, value }) {
  return (
    <div className="metric-card">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

function InfoItem({ label, value }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function isPgcryptoDigestError(message) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("digest") && normalized.includes("does not exist");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default App;

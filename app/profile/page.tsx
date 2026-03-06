"use client";

import { authClient } from "@/lib/auth-client";
import {
    UserIcon,
    MailIcon,
    CalendarIcon,
    FingerprintIcon,
    LogOutIcon,
    ShieldCheckIcon,
    BadgeCheckIcon,
    ShieldIcon
} from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
    const { data: session, isPending } = authClient.useSession();
    const router = useRouter();

    if (isPending) {
        return (
            <div className="flex items-center justify-center h-full min-h-[60vh]">
                <div className="size-8 rounded-full border-2 border-t-primary border-r-transparent border-b-transparent border-l-transparent animate-spin" />
            </div>
        );
    }

    if (!session) {
        return (
            <div className="flex flex-col items-center justify-center h-full min-h-[60vh] space-y-4">
                <ShieldIcon className="size-12 text-muted-foreground opacity-20" />
                <p className="text-muted-foreground">Please sign in to view your profile.</p>
            </div>
        );
    }

    const { user } = session;

    const handleLogout = async () => {
        await authClient.signOut({
            fetchOptions: {
                onSuccess: () => {
                    router.push("/");
                },
            },
        });
    };

    return (
        <div className="h-full overflow-y-auto scrollbar-thin">
            <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-12 space-y-8 sm:space-y-12">
                {/* Page Header */}
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                    className="relative"
                >
                    <div className="absolute -left-4 top-0 bottom-0 w-1 bg-gradient-to-b from-primary to-transparent opacity-50 hidden sm:block" />
                    <h1 className="text-3xl sm:text-4xl font-black text-foreground tracking-tight">Profile</h1>
                    <p className="text-sm sm:text-base text-muted-foreground mt-2 font-medium">
                        Manage your VEGA identity and account preferences.
                    </p>
                </motion.div>

                <div className="grid gap-6 sm:gap-8">
                    {/* Main Profile Identity Card */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.1, duration: 0.4 }}
                        className="group relative rounded-2xl border border-border bg-gradient-to-br from-card to-background p-6 sm:p-10 shadow-2xl overflow-hidden"
                    >
                        {/* Background Accent */}
                        <div className="absolute top-0 right-0 -mr-16 -mt-16 size-64 bg-primary/5 blur-[80px] rounded-full group-hover:bg-primary/10 transition-colors duration-500" />

                        <div className="relative flex flex-col sm:flex-row items-center sm:items-start gap-8 sm:gap-10">
                            {/* Avatar Section */}
                            <div className="relative shrink-0">
                                <div className="size-24 sm:size-32 rounded-2xl overflow-hidden border-2 border-border bg-background flex items-center justify-center shadow-inner group-hover:border-primary/30 transition-colors duration-300">
                                    {user.image ? (
                                        <Image
                                            src={user.image}
                                            alt={user.name}
                                            width={128}
                                            height={128}
                                            className="object-cover size-full"
                                        />
                                    ) : (
                                        <UserIcon className="size-12 sm:size-16 text-muted-foreground" />
                                    )}
                                </div>
                                {/* Status Indicator */}
                                <div className="absolute -bottom-1 -right-1 size-6 rounded-lg bg-emerald-500 border-4 border-background shadow-lg flex items-center justify-center" title="Active Account">
                                    <BadgeCheckIcon className="size-3 text-white" />
                                </div>
                            </div>

                            {/* Info Section */}
                            <div className="flex-1 text-center sm:text-left space-y-4">
                                <div className="space-y-1">
                                    <h2 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">{user.name}</h2>
                                    <div className="flex items-center justify-center sm:justify-start gap-2 text-muted-foreground">
                                        <MailIcon className="size-3.5" />
                                        <span className="text-sm font-medium">{user.email}</span>
                                    </div>
                                </div>

                                <div className="pt-2 flex flex-wrap justify-center sm:justify-start gap-3">
                                    <div className="px-3 py-1.5 rounded-full bg-card border border-border flex items-center gap-2">
                                        <ShieldCheckIcon className="size-3.5 text-primary" />
                                        <span className="text-[11px] font-bold uppercase tracking-wider text-foreground/80">Verified</span>
                                    </div>
                                    <div className="px-3 py-1.5 rounded-full bg-card border border-border flex items-center gap-2">
                                        <FingerprintIcon className="size-3.5 text-primary" />
                                        <span className="text-[11px] font-bold uppercase tracking-wider text-foreground/80">Biometric Ready</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </motion.div>

                    {/* Details Section */}
                    <div className="grid sm:grid-cols-2 gap-6">
                        <motion.div
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.2 }}
                            className="rounded-xl border border-border bg-card/50 p-6 space-y-4 shadow-sm"
                        >
                            <div className="flex items-center gap-2 text-foreground">
                                <CalendarIcon className="size-4 text-primary" />
                                <h3 className="text-sm font-bold uppercase tracking-widest opacity-80">Chronology</h3>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Created At</p>
                                    <p className="text-sm text-foreground font-medium mt-1">
                                        {new Date(user.createdAt).toLocaleDateString(undefined, {
                                            year: 'numeric',
                                            month: 'long',
                                            day: 'numeric'
                                        })}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Latest Pulse</p>
                                    <p className="text-sm text-foreground font-medium mt-1">
                                        {new Date(user.updatedAt).toLocaleTimeString(undefined, {
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        })}
                                    </p>
                                </div>
                            </div>
                        </motion.div>

                        <motion.div
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.3 }}
                            className="rounded-xl border border-border bg-card/50 p-6 space-y-4 shadow-sm"
                        >
                            <div className="flex items-center gap-2 text-foreground">
                                <ShieldIcon className="size-4 text-primary" />
                                <h3 className="text-sm font-bold uppercase tracking-widest opacity-80">System UID</h3>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Unique Identifier</p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <code className="px-2 py-1 rounded bg-secondary text-primary text-xs font-mono break-all line-clamp-2">
                                            {user.id}
                                        </code>
                                    </div>
                                </div>
                                <p className="text-[10px] text-muted-foreground/80 leading-relaxed">
                                    This ID is used for session validation and secure cross-module authentication.
                                </p>
                            </div>
                        </motion.div>
                    </div>

                    {/* Actions Section */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4 }}
                        className="pt-8 border-t border-border flex justify-center sm:justify-end"
                    >
                        <button
                            onClick={handleLogout}
                            className="group flex items-center gap-3 px-8 py-3 rounded-xl bg-red-600/10 border border-red-600/30 text-red-500 text-sm font-bold hover:bg-red-600 hover:text-white transition-all duration-300 active:scale-95 shadow-lg shadow-red-600/5 hover:shadow-red-600/20"
                        >
                            <LogOutIcon className="size-4 group-hover:-translate-x-1 transition-transform" />
                            Terminate Session
                        </button>
                    </motion.div>
                </div>

                {/* Footer Meta */}
                <p className="text-center text-[11px] text-muted-foreground/60 uppercase tracking-widest font-bold">
                    VEGA SECURITY PROTOCOL v4.2.0 • ENCRYPTED SESSION
                </p>
            </div>
        </div>
    );
}

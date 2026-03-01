import Image from "next/image";
import Link from "next/link";
import { BotIcon, GlobeIcon, CodeIcon, WorkflowIcon, BrainIcon, CalendarIcon, MailIcon } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0a0a0b] text-[#e8e8ea] font-mono selection:bg-[#00e5cc]/30 selection:text-[#00e5cc]">
      {/* ── 1. Hero Section ─────────────────────────────────────────────────── */}
      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-center">
        {/* Particle Grid Background (CSS only) */}
        <div className="absolute inset-0 z-0 opacity-20" 
             style={{ backgroundImage: "radial-gradient(#1e1e22 1px, transparent 1px)", backgroundSize: "40px 40px" }}>
        </div>
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-transparent via-[#0a0a0b]/50 to-[#0a0a0b]"></div>
        
        <div className="z-10 animate-in fade-in slide-in-from-bottom-8 duration-1000">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#1e1e22] bg-[#111113]/80 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#6b6b7a]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00e5cc] opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00e5cc]"></span>
            </span>
            System Status: Optimal
          </div>
          
          <h1 className="mb-4 text-7xl font-bold tracking-tighter sm:text-9xl">
            VEGA
          </h1>
          
          <p className="mb-10 max-w-lg text-sm uppercase tracking-[0.3em] text-[#6b6b7a] sm:text-base">
            Autonomous · Self-scheduling · Always-on
          </p>

          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/chat"
              className="group relative flex h-12 w-full items-center justify-center overflow-hidden rounded-sm bg-[#00e5cc] px-8 text-xs font-bold uppercase tracking-widest text-[#0a0a0b] transition-all hover:bg-[#00e5cc]/90 sm:w-auto"
            >
              <span className="relative z-10">→ Open Mission Control</span>
            </Link>
            
            <a
              href="https://github.com"
              target="_blank"
              className="flex h-12 w-full items-center justify-center border border-[#1e1e22] bg-[#111113]/50 px-8 text-xs font-bold uppercase tracking-widest transition-all hover:bg-[#1e1e22] sm:w-auto"
            >
              View Repository
            </a>
          </div>
        </div>

        <div className="absolute bottom-10 z-10 animate-bounce">
          <div className="h-10 w-[1px] bg-gradient-to-b from-[#00e5cc] to-transparent"></div>
        </div>
      </section>

      {/* ── 2. Capabilities Grid ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-32">
        <div className="mb-20 text-center">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.4em] text-[#00e5cc]">Core Capabilities</h2>
          <p className="text-2xl font-semibold tracking-tight">Equipped for Autonomous Success</p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <CapabilityCard 
            icon={<GlobeIcon className="size-5" />}
            title="Real-time Web Search"
            description="Accesses global information via Serper.dev to ground responses in current facts."
          />
          <CapabilityCard 
            icon={<CodeIcon className="size-5" />}
            title="Code Execution"
            description="Runs complex Python logic in secure sandboxes via E2B for math and data tasks."
          />
          <CapabilityCard 
            icon={<WorkflowIcon className="size-5" />}
            title="Durable Workflows"
            description="Orchestrates multi-hour tasks with Upstash Workflow. Resilient to any crash."
          />
          <CapabilityCard 
            icon={<BrainIcon className="size-5" />}
            title="Semantic Memory"
            description="Long-term RAG memory using Upstash Vector. Remembers concepts by meaning."
          />
          <CapabilityCard 
            icon={<CalendarIcon className="size-5" />}
            title="Self-Scheduling"
            description="Creates and manages its own recurring cron jobs via QStash for automation."
          />
          <CapabilityCard 
            icon={<MailIcon className="size-5" />}
            title="Email & SMS"
            description="Notifies you via Resend and Twilio when critical tasks or workflows complete."
          />
        </div>
      </section>

      {/* ── 3. Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-[#1e1e22] bg-[#0a0a0b] px-6 py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-8 sm:flex-row">
          <div className="flex items-center gap-4 grayscale opacity-50 transition-all hover:grayscale-0 hover:opacity-100">
            <span className="text-[10px] font-bold uppercase tracking-widest text-[#6b6b7a]">Built with</span>
            <span className="text-xs font-bold">Cloudflare</span>
            <span className="text-xs font-bold">Upstash</span>
            <span className="text-xs font-bold">Gemini</span>
          </div>
          
          <div className="flex gap-6 text-[10px] font-bold uppercase tracking-widest text-[#6b6b7a]">
            <Link href="/chat" className="hover:text-[#00e5cc]">Chat</Link>
            <a href="#" className="hover:text-[#00e5cc]">Docs</a>
            <a href="#" className="hover:text-[#00e5cc]">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function CapabilityCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="group relative overflow-hidden rounded-sm border border-[#1e1e22] bg-[#111113] p-8 transition-all hover:border-[#00e5cc]/50">
      <div className="mb-6 inline-flex size-10 items-center justify-center rounded-sm bg-[#0a0a0b] text-[#00e5cc] ring-1 ring-[#1e1e22] group-hover:ring-[#00e5cc]/30 transition-all">
        {icon}
      </div>
      <h3 className="mb-2 text-sm font-bold uppercase tracking-widest">{title}</h3>
      <p className="text-sm leading-relaxed text-[#6b6b7a] group-hover:text-[#e8e8ea] transition-all">
        {description}
      </p>
      
      {/* Accent glow on hover */}
      <div className="absolute -bottom-24 -right-24 size-48 rounded-full bg-[#00e5cc] opacity-0 blur-[100px] transition-all group-hover:opacity-10"></div>
    </div>
  );
}

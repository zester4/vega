export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-[#0a0a0b] text-[#e8e8ea] flex items-center justify-center p-4">
      {children}
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { name: "Datasets", href: "/dataset" },
  { name: "Build Study", href: "/pipeline" },
  { name: "Agent Evaluations", href: "/results" },
  { name: "Research Projects", href: "/collaboration" },
  { name: "GitHub", href: "https://github.com/HumanStudy-Hub/HumanStudy-Bench" },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-5 px-5 sm:px-8">
        <Link href="/" className="shrink-0 font-serif text-lg font-bold text-gray-950">
          HumanStudy-Hub
        </Link>
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto py-2">
          {links.map((link) => {
            const external = link.href.startsWith("http");
            const active = !external && pathname === link.href;
            const className = `whitespace-nowrap px-3 py-2 text-xs font-semibold transition-colors ${
              active ? "bg-cyan-50 text-cyan-800" : "text-gray-500 hover:text-gray-950"
            }`;
            return external ? (
              <a key={link.name} href={link.href} target="_blank" rel="noopener noreferrer" className={className}>{link.name}</a>
            ) : (
              <Link key={link.name} href={link.href} className={className}>{link.name}</Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

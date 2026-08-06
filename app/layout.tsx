import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'EMS Scheduler',
  description: 'Shift scheduling for EMS personnel',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Bitter:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Applies the last-known theme immediately, before React hydrates
            or any network request completes, to avoid a flash of the
            wrong theme. The database value (fetched by ThemeSync) is
            always the source of truth and overwrites this on load --
            this cached copy just makes the FIRST paint correct. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

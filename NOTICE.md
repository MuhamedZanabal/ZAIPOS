# Third-Party Notices

ZAIPOS is built on open-source software. This file acknowledges the major projects used by the application. For the complete dependency graph and exact installed versions, see `package-lock.json` and `package.json`.

## Core Framework and Build Tools

| Project | License | Usage |
|---|---|---|
| React | MIT | UI framework |
| React DOM | MIT | DOM renderer |
| React Router | MIT | Client-side routing |
| Vite | MIT | Build tool and development server |
| TypeScript | Apache-2.0 | Type system |
| SWC | Apache-2.0 / MIT | JSX and TypeScript compilation |

## Backend, Data, and Offline Runtime

| Project | License | Usage |
|---|---|---|
| Supabase client | MIT | Authentication, PostgreSQL access, Realtime, Edge Functions |
| Dexie | Apache-2.0 | IndexedDB and offline mutation queue |
| idb-keyval | Apache-2.0 | IndexedDB key-value storage |
| TanStack Query | MIT | Server state and synchronization |
| Zustand | MIT | Client state |

## UI and Application Libraries

ZAIPOS uses Tailwind CSS, Radix UI, shadcn/ui patterns, Lucide React, class-variance-authority, clsx, tailwind-merge, next-themes, vaul, cmdk, input-otp, Embla Carousel, Recharts, Sonner, date-fns, React Hook Form, Zod, and related open-source packages under their respective licenses.

## Desktop, Hardware, and PWA

ZAIPOS uses Electron, electron-builder, electron-store, electron-updater, node-thermal-printer, serialport, vite-plugin-pwa, and Workbox under their respective open-source licenses.

## Testing and Quality

ZAIPOS uses Vitest, React Testing Library, jsdom, ESLint, and TypeScript ESLint.

## Design Assets

The project may use fonts from Google Fonts and icons from Lucide under their respective licenses. Components under `src/components/ui/` follow MIT-licensed shadcn/ui patterns.

## ZAIPOS License

ZAIPOS is licensed under the MIT License. See [LICENSE](LICENSE).

This software includes code from third-party open-source projects. Their inclusion does not imply endorsement by the original authors. Each project retains its own copyright and license terms.

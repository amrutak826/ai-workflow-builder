import type { AppProps } from "next/app";
import { NhostProvider } from "@nhost/nextjs";
import { NhostUrqlProvider } from "@nhost/react-urql";
import { nhost } from "../lib/nhost";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <NhostProvider nhost={nhost}>
      <NhostUrqlProvider nhost={nhost}>
        <Component {...pageProps} />
      </NhostUrqlProvider>
    </NhostProvider>
  );
}

import Head from 'next/head';
import SFRUnderwriter from '../components/SFRUnderwriter';

export default function Home() {
  return (
    <>
      <Head>
        <title>SFR Underwriter | Only The Best Homes</title>
        <meta name="description" content="AI-powered single-family rental underwriting tool. Analyze any property in seconds." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <SFRUnderwriter />
    </>
  );
}

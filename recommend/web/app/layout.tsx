import "./globals.css";
export const metadata = {
  title: "ネロ王立図書館 🌙",
  description: "メンバーの記事発掘と、紹介のための小さな編集室。",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

import "./globals.css";

export const metadata = {
  title: "Meet Datasiber",
  description: "Video meetings by Datasiber"
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}

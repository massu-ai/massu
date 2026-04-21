export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}

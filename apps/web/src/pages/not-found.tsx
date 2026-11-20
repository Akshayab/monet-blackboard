import { Link } from 'wouter';
import { LogoMark } from '@/components/logo';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="grid min-h-screen w-full place-items-center bg-background px-6">
      <div className="max-w-sm text-center">
        <LogoMark className="mx-auto h-12 w-12" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page doesn't exist, or it moved. Your boards are still safe in your library.</p>
        <Button asChild className="mt-6">
          <Link href="/">Back to your boards</Link>
        </Button>
      </div>
    </main>
  );
}

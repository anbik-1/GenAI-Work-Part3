import { BookOpen } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t bg-background">
      <div className="container flex flex-col items-center gap-4 py-8 md:flex-row md:justify-between">
        <div className="flex items-center space-x-2">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            AnyCompanyRead &copy; {new Date().getFullYear()}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          A demo application built with React, shadcn/ui, and AWS Serverless.
        </p>
      </div>
    </footer>
  );
}

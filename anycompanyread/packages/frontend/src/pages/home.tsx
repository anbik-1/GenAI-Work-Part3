import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Book } from '@anycompanyread/shared';
import { api } from '@/lib/api';

export function HomePage() {
  const [featuredBooks, setFeaturedBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchFeatured() {
      try {
        const data = await api.get<{ books: Book[] }>('/books?limit=4');
        setFeaturedBooks(data.books);
      } catch (err) {
        console.error('Failed to fetch featured books:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchFeatured();
  }, []);

  return (
    <div className="flex flex-col">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-background to-secondary/20 py-20 md:py-32">
        <div className="container flex flex-col items-center text-center space-y-8">
          <div className="flex items-center space-x-3">
            <BookOpen className="h-12 w-12 text-primary" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Welcome to{' '}
            <span className="text-primary">AnyCompanyRead</span>
          </h1>
          <p className="max-w-[600px] text-lg text-muted-foreground md:text-xl">
            Discover your next favorite book. Browse our curated collection of titles across every genre.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Button size="lg" asChild>
              <Link to="/books">
                Browse Books <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link to="/signup">Create Account</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Featured Books Section */}
      <section className="container py-16">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-3xl font-bold tracking-tight">Featured Books</h2>
          <Button variant="ghost" asChild>
            <Link to="/books">
              View all <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="w-full h-48 mb-4 rounded" />
                    <Skeleton className="h-5 w-3/4 mb-2" />
                    <Skeleton className="h-4 w-1/2 mb-2" />
                    <Skeleton className="h-4 w-1/4" />
                  </CardContent>
                </Card>
              ))
            : featuredBooks.map((book) => (
                <Link key={book.bookId} to={`/books/${book.bookId}`}>
                  <Card className="overflow-hidden transition-all hover:shadow-lg hover:-translate-y-1">
                    <CardContent className="p-4">
                      <img
                        src={book.coverImageUrl}
                        alt={book.title}
                        className="w-full h-48 object-cover rounded mb-4"
                      />
                      <h3 className="font-semibold line-clamp-1">{book.title}</h3>
                      <p className="text-sm text-muted-foreground">{book.author}</p>
                      <p className="text-lg font-bold text-primary mt-2">
                        ${book.price.toFixed(2)}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
        </div>
      </section>
    </div>
  );
}

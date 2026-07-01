import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ShoppingCart, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/ui/use-toast';
import { Book } from '@anycompanyread/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { useCart } from '@/contexts/cart-context';

export function BookDetailPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isAuthenticated } = useAuth();
  const { addToCart } = useCart();

  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    async function fetchBook() {
      if (!bookId) return;
      setLoading(true);
      try {
        const data = await api.get<{ book: Book }>(`/books/${bookId}`);
        setBook(data.book);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load book');
      } finally {
        setLoading(false);
      }
    }
    fetchBook();
  }, [bookId]);

  const handleAddToCart = async () => {
    if (!isAuthenticated) {
      toast({ title: 'Please log in', description: 'You need to be logged in to add items to your cart.', variant: 'destructive' });
      navigate('/login');
      return;
    }
    if (!bookId) return;
    setAdding(true);
    try {
      await addToCart(bookId);
      toast({ title: 'Added to cart!', description: `"${book?.title}" has been added to your cart.`, variant: 'success' });
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to add to cart', variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  if (loading) {
    return (
      <div className="container py-8">
        <Skeleton className="h-8 w-32 mb-6" />
        <div className="grid md:grid-cols-2 gap-8">
          <Skeleton className="h-96 rounded-lg" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="container py-8">
        <Alert variant="destructive">
          <AlertDescription>{error || 'Book not found'}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <Button variant="ghost" onClick={() => navigate(-1)} className="mb-6">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Book Cover */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <img
              src={book.coverImageUrl}
              alt={book.title}
              className="w-full h-auto max-h-[500px] object-cover"
            />
          </CardContent>
        </Card>

        {/* Book Details */}
        <div className="flex flex-col space-y-6">
          <div>
            <Badge variant="secondary" className="mb-2">{book.genre}</Badge>
            <h1 className="text-3xl font-bold">{book.title}</h1>
            <p className="text-lg text-muted-foreground mt-1">by {book.author}</p>
          </div>

          <div className="flex items-center space-x-2">
            <div className="flex items-center">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className={`h-5 w-5 ${i < Math.round(book.rating) ? 'fill-yellow-400 text-yellow-400' : 'text-muted'}`}
                />
              ))}
            </div>
            <span className="text-sm text-muted-foreground">({book.rating.toFixed(1)})</span>
          </div>

          <p className="text-3xl font-bold text-primary">${book.price.toFixed(2)}</p>

          <Separator />

          <p className="text-muted-foreground leading-relaxed">{book.description}</p>

          <Separator />

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">ISBN:</span>
              <p className="font-medium">{book.isbn}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Pages:</span>
              <p className="font-medium">{book.pageCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Published:</span>
              <p className="font-medium">{book.publishedYear}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Genre:</span>
              <p className="font-medium">{book.genre}</p>
            </div>
          </div>

          <Button size="lg" className="w-full md:w-auto" onClick={handleAddToCart} disabled={adding}>
            <ShoppingCart className="mr-2 h-5 w-5" />
            {adding ? 'Adding...' : 'Add to Cart'}
          </Button>
        </div>
      </div>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Book } from '@anycompanyread/shared';

interface BookCardProps {
  book: Book;
}

export function BookCard({ book }: BookCardProps) {
  return (
    <Link to={`/books/${book.bookId}`}>
      <Card className="overflow-hidden transition-all hover:shadow-lg hover:-translate-y-1 h-full">
        <CardContent className="p-4 flex flex-col h-full">
          <img
            src={book.coverImageUrl}
            alt={book.title}
            className="w-full h-48 object-cover rounded mb-4"
          />
          <h3 className="font-semibold line-clamp-1 mb-1">{book.title}</h3>
          <p className="text-sm text-muted-foreground mb-2">{book.author}</p>
          <div className="flex items-center space-x-1 mb-2">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
            <span className="text-sm text-muted-foreground">{book.rating.toFixed(1)}</span>
          </div>
          <p className="text-lg font-bold text-primary mt-auto">
            ${book.price.toFixed(2)}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

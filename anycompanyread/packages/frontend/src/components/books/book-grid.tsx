import { Book } from '@anycompanyread/shared';
import { BookCard } from './book-card';

interface BookGridProps {
  books: Book[];
}

export function BookGrid({ books }: BookGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
      {books.map((book) => (
        <BookCard key={book.bookId} book={book} />
      ))}
    </div>
  );
}

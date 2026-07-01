/** Represents a book in the catalog */
export interface Book {
  bookId: string;
  title: string;
  author: string;
  isbn: string;
  genre: string;
  description: string;
  price: number;
  coverImageUrl: string;
  rating: number;
  pageCount: number;
  publishedYear: number;
  createdAt: string;
}

/** Book summary for list views (same shape, used for clarity) */
export type BookSummary = Pick<
  Book,
  'bookId' | 'title' | 'author' | 'genre' | 'price' | 'coverImageUrl' | 'rating'
>;

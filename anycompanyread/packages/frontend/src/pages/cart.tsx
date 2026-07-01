import { useNavigate } from 'react-router-dom';
import { Minus, Plus, Trash2, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/use-toast';
import { useCart } from '@/contexts/cart-context';
import { useState } from 'react';

export function CartPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { items, totalPrice, loading, updateQuantity, removeItem, checkout } = useCart();
  const [checkingOut, setCheckingOut] = useState(false);

  const handleQuantityChange = async (bookId: string, newQuantity: number) => {
    if (newQuantity < 1) return;
    try {
      await updateQuantity(bookId, newQuantity);
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to update quantity', variant: 'destructive' });
    }
  };

  const handleRemove = async (bookId: string) => {
    try {
      await removeItem(bookId);
      toast({ title: 'Removed', description: 'Item removed from cart' });
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to remove item', variant: 'destructive' });
    }
  };

  const handleCheckout = async () => {
    setCheckingOut(true);
    try {
      await checkout();
      toast({ title: 'Order placed!', description: 'Your order has been confirmed. Check your orders page for details.', variant: 'success' });
      navigate('/orders');
    } catch (err) {
      toast({ title: 'Checkout failed', description: err instanceof Error ? err.message : 'An error occurred', variant: 'destructive' });
    } finally {
      setCheckingOut(false);
    }
  };

  if (loading) {
    return (
      <div className="container py-8">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="container py-16 text-center">
        <ShoppingBag className="mx-auto h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-2xl font-bold mb-2">Your cart is empty</h2>
        <p className="text-muted-foreground mb-6">Start adding books to see them here.</p>
        <Button onClick={() => navigate('/books')}>Browse Books</Button>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <h1 className="text-3xl font-bold tracking-tight mb-6">Shopping Cart</h1>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Cart items */}
        <div className="lg:col-span-2">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Book</TableHead>
                  <TableHead className="text-center">Quantity</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.bookId}>
                    <TableCell>
                      <div className="flex items-center space-x-4">
                        <img
                          src={item.coverImageUrl}
                          alt={item.title}
                          className="h-16 w-12 object-cover rounded"
                        />
                        <div>
                          <p className="font-medium line-clamp-1">{item.title}</p>
                          <p className="text-sm text-muted-foreground">${item.price.toFixed(2)}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center space-x-2">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleQuantityChange(item.bookId, item.quantity - 1)}
                          disabled={item.quantity <= 1}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-8 text-center font-medium">{item.quantity}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleQuantityChange(item.bookId, item.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      ${(item.price * item.quantity).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove item?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remove &quot;{item.title}&quot; from your cart?
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleRemove(item.bookId)}>
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>

        {/* Order summary */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle>Order Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal ({items.length} items)</span>
                <span>${totalPrice.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Shipping</span>
                <span className="text-green-600">Free</span>
              </div>
              <Separator />
              <div className="flex justify-between font-bold text-lg">
                <span>Total</span>
                <span className="text-primary">${totalPrice.toFixed(2)}</span>
              </div>
            </CardContent>
            <CardFooter>
              <Button className="w-full" size="lg" onClick={handleCheckout} disabled={checkingOut}>
                {checkingOut ? 'Processing...' : 'Checkout'}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Package, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Order, OrderDetail } from '@anycompanyread/shared';
import { api } from '@/lib/api';

export function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchOrders() {
      try {
        const data = await api.get<{ orders: Order[] }>('/orders');
        setOrders(data.orders);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load orders');
      } finally {
        setLoading(false);
      }
    }
    fetchOrders();
  }, []);

  const handleViewOrder = async (orderId: string) => {
    setDetailLoading(true);
    try {
      const data = await api.get<{ order: OrderDetail }>(`/orders/${orderId}`);
      setSelectedOrder(data.order);
    } catch (err) {
      console.error('Failed to load order detail:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'CONFIRMED': return 'default' as const;
      case 'PROCESSING': return 'secondary' as const;
      case 'SHIPPED': return 'outline' as const;
      case 'DELIVERED': return 'default' as const;
      default: return 'secondary' as const;
    }
  };

  if (loading) {
    return (
      <div className="container py-8">
        <Skeleton className="h-8 w-48 mb-6" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full mb-4" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="container py-8">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="container py-16 text-center">
        <Package className="mx-auto h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-2xl font-bold mb-2">No orders yet</h2>
        <p className="text-muted-foreground">Your order history will appear here after you make a purchase.</p>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <h1 className="text-3xl font-bold tracking-tight mb-6">My Orders</h1>

      <div className="space-y-4">
        {orders.map((order) => (
          <Card key={order.orderId} className="hover:shadow-md transition-shadow">
            <CardContent className="flex items-center justify-between p-6">
              <div className="space-y-1">
                <p className="font-medium">Order #{order.orderId.slice(0, 8)}</p>
                <p className="text-sm text-muted-foreground">
                  {new Date(order.createdAt).toLocaleDateString('en-US', {
                    year: 'numeric', month: 'long', day: 'numeric',
                  })}
                </p>
                <div className="flex items-center space-x-3">
                  <Badge variant={getStatusBadgeVariant(order.status)}>
                    {order.status}
                  </Badge>
                  <span className="text-sm text-muted-foreground">{order.itemCount} items</span>
                </div>
              </div>
              <div className="flex items-center space-x-4">
                <p className="text-lg font-bold">${order.totalPrice.toFixed(2)}</p>
                <Button variant="ghost" size="icon" onClick={() => handleViewOrder(order.orderId)}>
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Order Detail Dialog */}
      <Dialog open={!!selectedOrder} onOpenChange={() => setSelectedOrder(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Order Details</DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <div className="space-y-4 py-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : selectedOrder ? (
            <div className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Order ID</span>
                <span className="font-mono">{selectedOrder.orderId.slice(0, 8)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Date</span>
                <span>{new Date(selectedOrder.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={getStatusBadgeVariant(selectedOrder.status)}>
                  {selectedOrder.status}
                </Badge>
              </div>
              <Separator />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-center">Qty</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedOrder.items.map((item) => (
                    <TableRow key={item.bookId}>
                      <TableCell className="font-medium">{item.title}</TableCell>
                      <TableCell className="text-center">{item.quantity}</TableCell>
                      <TableCell className="text-right">${(item.price * item.quantity).toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Separator />
              <div className="flex justify-between font-bold">
                <span>Total</span>
                <span>${selectedOrder.totalPrice.toFixed(2)}</span>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

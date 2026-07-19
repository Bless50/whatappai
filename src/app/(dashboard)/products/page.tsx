"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Loader2,
  Edit,
  Package,
  Search,
  Upload,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Product {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: number;
  image_url: string | null;
  sku: string | null;
  created_at: string;
}

export default function ProductsPage() {
  const { accountId } = useAuth();
  const supabase = createClient();

  const [products, setProducts] = useState<Product[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [isLoading, setIsLoading] = useState(true);

  // Modal / Form state
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Form Fields
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formPrice, setFormPrice] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formSku, setFormSku] = useState("");
  const [formImageUrl, setFormImageUrl] = useState("");

  // Delete Confirm Dialog state
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    fetchProducts();
  }, [accountId]);

  const fetchProducts = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setProducts(data || []);
    } catch (err) {
      console.error("Error fetching products:", err);
      toast.error("Failed to load products");
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenCreate = () => {
    setIsEditing(false);
    setEditingId(null);
    setFormName("");
    setFormCategory("");
    setFormPrice("");
    setFormDesc("");
    setFormSku("");
    setFormImageUrl("");
    setIsOpen(true);
  };

  const handleOpenEdit = (p: Product) => {
    setIsEditing(true);
    setEditingId(p.id);
    setFormName(p.name);
    setFormCategory(p.category || "");
    setFormPrice(p.price.toString());
    setFormDesc(p.description || "");
    setFormSku(p.sku || "");
    setFormImageUrl(p.image_url || "");
    setIsOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !accountId) {
      toast.error("Product name is required");
      return;
    }

    const priceNum = parseFloat(formPrice) || 0;
    setIsSaving(true);

    try {
      if (isEditing && editingId) {
        const { error } = await supabase
          .from("products")
          .update({
            name: formName,
            category: formCategory || null,
            price: priceNum,
            description: formDesc || null,
            sku: formSku || null,
            image_url: formImageUrl || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", editingId);

        if (error) throw error;
        toast.success("Product updated successfully!");
      } else {
        const { error } = await supabase
          .from("products")
          .insert([
            {
              account_id: accountId,
              name: formName,
              category: formCategory || null,
              price: priceNum,
              description: formDesc || null,
              sku: formSku || null,
              image_url: formImageUrl || null,
            },
          ]);

        if (error) throw error;
        toast.success("Product added successfully!");
      }

      setIsOpen(false);
      fetchProducts();
    } catch (err) {
      console.error("Error saving product:", err);
      toast.error("Failed to save product");
    } finally {
      setIsSaving(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }

    setIsUploading(true);
    try {
      const result = await uploadAccountMedia("chat-media", file);
      setFormImageUrl(result.publicUrl);
      toast.success("Image uploaded successfully!");
    } catch (err) {
      console.error("Upload error:", err);
      toast.error(err instanceof Error ? err.message : "Failed to upload image");
    } finally {
      setIsUploading(false);
    }
  };

  const handleOpenDelete = (id: string) => {
    setDeletingId(id);
    setIsDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingId) return;

    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from("products")
        .delete()
        .eq("id", deletingId);

      if (error) throw error;
      toast.success("Product deleted successfully");
      setIsDeleteOpen(false);
      fetchProducts();
    } catch (err) {
      console.error("Delete error:", err);
      toast.error("Failed to delete product");
    } finally {
      setIsDeleting(false);
      setDeletingId(null);
    }
  };

  // Get distinct categories in database for filters
  const categories = ["all", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean)))];

  // Filtering products
  const filteredProducts = products.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (p.sku && p.sku.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesCategory =
      selectedCategory === "all" || p.category?.toLowerCase() === selectedCategory.toLowerCase();

    return matchesSearch && matchesCategory;
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-green" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-8 max-w-7xl mx-auto w-full">
      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-brand-green">
            Products Catalog
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your inventory catalog. Your AI agents will read descriptions and send pictures of these items directly on WhatsApp.
          </p>
        </div>
        <Button onClick={handleOpenCreate} className="bg-brand-green hover:bg-brand-green/90 shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          Add Product
        </Button>
      </div>

      {/* Filters section */}
      <div className="flex flex-col sm:flex-row gap-4 items-center bg-card p-4 rounded-xl border shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, description or SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Label htmlFor="category-filter" className="text-sm text-muted-foreground shrink-0">
            Category:
          </Label>
          <select
            id="category-filter"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm sm:w-48"
          >
            {categories.map((c) => (
              <option key={c} value={c || ""}>
                {c === "all" ? "All Categories" : c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Product List/Grid */}
      {filteredProducts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center bg-card shadow-sm">
          <div className="rounded-full bg-brand-green/10 p-4">
            <Package className="h-8 w-8 text-brand-green" />
          </div>
          <h3 className="mt-4 text-xl font-semibold">No products found</h3>
          <p className="mt-2 text-sm text-muted-foreground max-w-sm">
            {searchQuery || selectedCategory !== "all"
              ? "No items match your active search filters. Try clearing filters or searching for something else."
              : "Your product catalog is empty. Add items to help your AI agents sell them to clients."}
          </p>
          {(searchQuery || selectedCategory !== "all") ? (
            <Button
              variant="outline"
              onClick={() => {
                setSearchQuery("");
                setSelectedCategory("all");
              }}
              className="mt-6"
            >
              Clear Filters
            </Button>
          ) : (
            <Button onClick={handleOpenCreate} className="mt-6 bg-brand-green hover:bg-brand-green/90">
              <Plus className="mr-2 h-4 w-4" />
              Add Product
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProducts.map((product) => (
            <Card key={product.id} className="flex flex-col overflow-hidden transition-all hover:shadow-md border">
              {/* Product Image preview */}
              <div className="relative aspect-video w-full bg-muted flex items-center justify-center border-b overflow-hidden">
                {product.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={product.image_url}
                    alt={product.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
                    <ImageIcon className="h-10 w-10 opacity-40" />
                    <span className="text-xs">No image uploaded</span>
                  </div>
                )}
                {product.category && (
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-brand-green/90 px-2.5 py-0.5 text-xs font-semibold text-white shadow-sm">
                    {product.category}
                  </span>
                )}
              </div>

              {/* Card info */}
              <CardHeader className="p-5 pb-3">
                <div className="flex justify-between items-start gap-2">
                  <CardTitle className="text-lg font-bold line-clamp-1">{product.name}</CardTitle>
                  <span className="text-lg font-extrabold text-brand-green shrink-0">
                    {product.price.toLocaleString()}F
                  </span>
                </div>
                {product.sku && (
                  <CardDescription className="text-xs font-mono text-muted-foreground">
                    SKU: {product.sku}
                  </CardDescription>
                )}
              </CardHeader>

              <CardContent className="p-5 pt-0 flex-1">
                <p className="text-sm text-muted-foreground line-clamp-3 min-h-[3.75rem]">
                  {product.description || <em className="text-muted-foreground/60">No description provided.</em>}
                </p>
              </CardContent>

              {/* Actions footer */}
              <CardFooter className="flex justify-end gap-2 border-t bg-muted/10 p-3.5">
                <Button variant="outline" size="sm" onClick={() => handleOpenEdit(product)}>
                  <Edit className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button variant="destructive" size="sm" onClick={() => handleOpenDelete(product.id)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Product" : "Add Product"}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update your product details. Any updates are immediately accessible by active AI agents."
                : "Fill in the details to add this product to the AI-accessible catalog."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="grid gap-4 py-3">
            <div className="grid gap-1.5">
              <Label htmlFor="prod-name">Product Name *</Label>
              <Input
                id="prod-name"
                placeholder="e.g. Spaghetti Strap Flowy Dress"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="prod-price">Price (F) *</Label>
                <Input
                  id="prod-price"
                  type="number"
                  placeholder="e.g. 10500"
                  value={formPrice}
                  onChange={(e) => setFormPrice(e.target.value)}
                  required
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="prod-category">Category</Label>
                <Input
                  id="prod-category"
                  placeholder="e.g. Dresses, Shoes"
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="prod-sku">SKU (Optional)</Label>
                <Input
                  id="prod-sku"
                  placeholder="e.g. DRESS-001"
                  value={formSku}
                  onChange={(e) => setFormSku(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Image URL (Optional)</Label>
                <Input
                  placeholder="Paste URL or upload image below"
                  value={formImageUrl}
                  onChange={(e) => setFormImageUrl(e.target.value)}
                />
              </div>
            </div>

            {/* Description is key since the LLM searches text fields */}
            <div className="grid gap-1.5">
              <Label htmlFor="prod-desc">Description (Used by AI for Search) *</Label>
              <Textarea
                id="prod-desc"
                placeholder="Describe details like materials, colors, available sizes, or designs so that the AI can search for this product matching customer requests."
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                rows={3}
              />
            </div>

            {/* Upload Area */}
            <div className="grid gap-2">
              <Label>Product Photo</Label>
              <div className="flex items-center gap-4 p-3 rounded-lg border bg-muted/20">
                {formImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={formImageUrl}
                    alt="Preview"
                    className="h-14 w-20 rounded object-cover border"
                  />
                ) : (
                  <div className="h-14 w-20 rounded bg-muted flex items-center justify-center border text-muted-foreground">
                    <ImageIcon className="h-5 w-5" />
                  </div>
                )}
                <div className="flex-1">
                  <input
                    type="file"
                    id="image-file-input"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                    disabled={isUploading}
                  />
                  <Label
                    htmlFor="image-file-input"
                    className="inline-flex items-center justify-center rounded-md text-xs font-semibold ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 px-3 cursor-pointer"
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="mr-2 h-3.5 w-3.5" />
                        Upload Photo
                      </>
                    )}
                  </Label>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Max size: 5MB (Meta WhatsApp limit).
                  </p>
                </div>
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving || isUploading} className="bg-brand-green hover:bg-brand-green/90">
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEditing ? "Save Changes" : "Add Product"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete Product</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this product? This action is permanent and cannot be undone. Active AI agents will immediately lose access to this item.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

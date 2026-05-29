import { useState, useCallback } from "preact/hooks";

type Errors<T> = Partial<Record<keyof T, string>>;

/** Lightweight form-state hook: values, field errors, submit lifecycle. */
export function useForm<T extends Record<string, unknown>>(initialValues: T) {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Errors<T>>({});
  const [submitting, setSubmitting] = useState(false);

  const setValue = useCallback((field: keyof T, value: unknown) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }, []);

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
  }, [initialValues]);

  const handleSubmit = useCallback(
    async (submitFn: (values: T) => Promise<void>) => {
      setSubmitting(true);
      try {
        await submitFn(values);
      } finally {
        setSubmitting(false);
      }
    },
    [values],
  );

  return { values, errors, submitting, setValue, setValues, setErrors, reset, handleSubmit };
}

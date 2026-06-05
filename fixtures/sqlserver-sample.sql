if object_id('dbo.sale_order', 'U') is null
begin
  create table dbo.sale_order (
    id bigint identity(1,1) primary key,
    customer_id varchar(64) not null,
    order_no varchar(64) not null,
    amount decimal(18, 2) not null,
    mobile varchar(32),
    created_at datetime2 not null default sysdatetime()
  );
end;

insert into dbo.sale_order (customer_id, order_no, amount, mobile)
values ('C001', 'SO-001', 1280.50, '13800000000');
